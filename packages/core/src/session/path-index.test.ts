import { describe, expect, it } from 'vitest';
import { SessionPathIndex, normalizeRef } from './path-index';

/** a claude transcript record carrying one tool call, as actually written */
const toolUse = (name: string, input: Record<string, unknown>, cwd = '/repo') =>
  JSON.stringify({
    type: 'assistant',
    cwd,
    gitBranch: 'main',
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
  });

describe('SessionPathIndex', () => {
  it('harvests absolute file paths out of tool calls', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(toolUse('Read', { file_path: '/repo/src/app.ts' }));
    ix.noteLine(toolUse('Edit', { file_path: '/repo/docs/readme.md' }));
    expect(ix.size()).toBe(2);
    expect(ix.resolve('src/app.ts')).toEqual(['/repo/src/app.ts']);
  });

  it('resolves a bare filename the agent printed without its directory', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(toolUse('Read', { file_path: '/repo/deep/nested/notes.md' }));
    expect(ix.resolve('notes.md')).toEqual(['/repo/deep/nested/notes.md']);
  });

  it('prefers a full tail match over a same-name file elsewhere', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(toolUse('Read', { file_path: '/repo/a/index.ts' }));
    ix.noteLine(toolUse('Read', { file_path: '/repo/b/index.ts' }));
    expect(ix.resolve('b/index.ts')).toEqual(['/repo/b/index.ts']);
  });

  it('returns every same-name candidate when the reference is ambiguous', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(toolUse('Read', { file_path: '/repo/a/index.ts' }));
    ix.noteLine(toolUse('Read', { file_path: '/repo/b/index.ts' }));
    // newest first — the file just touched is the likelier intent
    expect(ix.resolve('index.ts')).toEqual(['/repo/b/index.ts', '/repo/a/index.ts']);
  });

  it('a real b/ directory beats the git-diff-prefix reading', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(toolUse('Read', { file_path: '/repo/a/index.ts' }));
    ix.noteLine(toolUse('Read', { file_path: '/repo/b/index.ts' }));
    expect(ix.resolve('b/index.ts')).toEqual(['/repo/b/index.ts']);
    expect(ix.resolve('a/index.ts')).toEqual(['/repo/a/index.ts']);
  });

  it('strips ./ and git a/ b/ diff prefixes', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(toolUse('Read', { file_path: '/repo/server/index.js' }));
    expect(ix.resolve('./server/index.js')).toEqual(['/repo/server/index.js']);
    expect(ix.resolve('b/server/index.js')).toEqual(['/repo/server/index.js']);
    expect(normalizeRef('a/x.ts')).toBe('x.ts');
  });

  it('tracks the cwd the agent reports', () => {
    const ix = new SessionPathIndex();
    expect(ix.cwd()).toBeUndefined();
    ix.noteLine(toolUse('Read', { file_path: '/repo/x.ts' }, '/repo/sub'));
    expect(ix.cwd()).toBe('/repo/sub');
  });

  it('ignores relative paths, prose, and malformed lines', () => {
    const ix = new SessionPathIndex();
    ix.noteLine('not json at all');
    ix.noteLine('{"partial": ');
    ix.noteLine(toolUse('Read', { file_path: 'relative/only.ts' }));
    ix.noteLine(
      JSON.stringify({
        message: { content: [{ type: 'text', text: '/this/is/prose/not/a/path/key' }] },
      }),
    );
    expect(ix.size()).toBe(0);
  });

  it('re-seeing a path moves it to the front instead of duplicating', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(toolUse('Read', { file_path: '/repo/a/x.ts' }));
    ix.noteLine(toolUse('Read', { file_path: '/repo/b/x.ts' }));
    ix.noteLine(toolUse('Edit', { file_path: '/repo/a/x.ts' }));
    expect(ix.size()).toBe(2);
    expect(ix.resolve('x.ts')).toEqual(['/repo/a/x.ts', '/repo/b/x.ts']);
  });

  it('stays bounded over a very long session', () => {
    const ix = new SessionPathIndex();
    for (let i = 0; i < 2500; i++) {
      ix.noteLine(toolUse('Read', { file_path: `/repo/f${i}/file${i}.ts` }));
    }
    expect(ix.size()).toBe(2000);
    expect(ix.resolve('file0.ts')).toEqual([]); // oldest evicted
    expect(ix.resolve('file2499.ts')).toEqual(['/repo/f2499/file2499.ts']);
  });

  it('does not walk deep into giant records', () => {
    const ix = new SessionPathIndex();
    // a 1MB base64 tool_result must not cost us a full traversal
    const huge = { type: 'user', message: { content: [{ type: 'tool_result', data: 'x'.repeat(200) }] } };
    ix.noteLine(JSON.stringify(huge));
    expect(ix.size()).toBe(0);
  });

  it('is empty for a reference it never saw', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(toolUse('Read', { file_path: '/repo/a.ts' }));
    expect(ix.resolve('nowhere/b.ts')).toEqual([]);
  });
});

describe('directories learned from shell commands', () => {
  it('remembers where a `cd` put the agent', () => {
    const idx = new SessionPathIndex();
    idx.noteRecord({
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: "cd /srv/app && cat > docs/x.md <<'EOF'\nbody\nEOF" },
          },
        ],
      },
    });
    expect(idx.dirs()).toContain('/srv/app');
  });

  it('takes quoted paths, and ignores a relative cd it cannot interpret', () => {
    const idx = new SessionPathIndex();
    idx.noteShellCommand('cd "/srv/one with space" && ls');
    idx.noteShellCommand("cd '/srv/two' && ls");
    idx.noteShellCommand('cd ../sibling && ls');
    expect(idx.dirs()).toEqual(['/srv/two', '/srv/one with space']);
  });

  it('stops scanning before a heredoc body — a written file is not a command', () => {
    const idx = new SessionPathIndex();
    const body = 'x'.repeat(1000);
    idx.noteShellCommand(`cd /srv/real && cat > f <<'EOF'\n${body} cd /srv/fake\nEOF`);
    expect(idx.dirs()).toEqual(['/srv/real']);
  });

  it('most recent directory wins, and re-visiting one moves it back to front', () => {
    const idx = new SessionPathIndex();
    idx.noteShellCommand('cd /a && x');
    idx.noteShellCommand('cd /b && x');
    idx.noteShellCommand('cd /a && x');
    expect(idx.dirs().slice(0, 2)).toEqual(['/a', '/b']);
  });

  it('a harvested absolute path also teaches its parent directory', () => {
    const idx = new SessionPathIndex();
    idx.noteRecord({ message: { content: [{ type: 'tool_use', input: { file_path: '/p/q/r.ts' } }] } });
    expect(idx.dirs()).toContain('/p/q');
  });
});

describe('files named in shell commands', () => {
  const bash = (command: string, cwd = '/repo/server') =>
    JSON.stringify({
      type: 'assistant',
      cwd,
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
    });

  it('anchors a relative argument at the record cwd, so a shorter citation resolves', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(bash('grep -v "^#" prompts/profile/request.txt | head -60'));
    expect(ix.resolve('profile/request.txt')).toEqual(['/repo/server/prompts/profile/request.txt']);
  });

  it('follows an absolute cd inside the command, and folds ../', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(bash('cd /srv/app && cat src/a.ts ../lib/b.js'));
    expect(ix.resolve('src/a.ts')).toEqual(['/srv/app/src/a.ts']);
    expect(ix.resolve('lib/b.js')).toEqual(['/srv/lib/b.js']);
  });

  it('takes absolute arguments as they are, quoted or redirected', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(bash(`sed -n 1,5p '/abs/x/y.md' > /tmp/out/z.log`));
    expect(ix.resolve('x/y.md')).toEqual(['/abs/x/y.md']);
    expect(ix.resolve('out/z.log')).toEqual(['/tmp/out/z.log']);
  });

  it('drops relative arguments after a relative cd it cannot interpret', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(bash('cd ../other && cat docs/a.md'));
    expect(ix.size()).toBe(0);
  });

  it('ignores URLs, bare filenames, and words without an extension', () => {
    const ix = new SessionPathIndex();
    ix.noteLine(bash('curl https://cdn.x.com/lib/a.js -o a.js && git log origin/main'));
    expect(ix.size()).toBe(0);
  });
});
