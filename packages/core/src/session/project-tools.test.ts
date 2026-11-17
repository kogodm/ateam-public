import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectTools, compileIgnore } from './project-tools';

let root: string;
let outside: string;
let tools: ProjectTools;
type Page = Extract<ReturnType<ProjectTools['readFile']>, { text: string }>;
const read = (path: string, start?: number, end?: number) =>
  tools.readFile('p', path, start, end) as Page;
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-project-tools-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-outside-')));
  writeFileSync(join(outside, 'secret.txt'), 'outside secret');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'private'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { test: 'vitest' } }),
  );
  writeFileSync(
    join(root, 'src', 'ads.ts'),
    'export function onAdClosed() {\n  reward();\n}\nconst token = "sk-abcdefghijklmnopqrstu";\n',
  );
  writeFileSync(
    join(root, 'src', 'big.ts'),
    Array.from({ length: 1000 }, (_, i) => `line ${i + 1} reward`).join('\n'),
  );
  writeFileSync(join(root, '.env'), 'API_KEY=shh');
  writeFileSync(join(root, '.env.example'), 'API_KEY=');
  writeFileSync(join(root, 'deploy.pem'), '-----BEGIN PRIVATE KEY-----');
  writeFileSync(join(root, 'private', 'notes.md'), 'reward private');
  writeFileSync(join(root, '.aiignore'), 'private/\n');
  writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  symlinkSync(outside, join(root, 'escape'));
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');
  writeFileSync(
    join(root, 'src', 'ads.ts'),
    'export function onAdClosed() {\n  reward(true);\n}\n',
  );
  writeFileSync(join(root, '.env'), 'API_KEY=changed');
  tools = new ProjectTools(() => root);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('ignore rules', () => {
  it('matches gitignore-style patterns with directories and negation', () => {
    const t = compileIgnore(['.env', '.env.*', '!.env.example', '*.pem', 'private/', '/build']);
    expect(t('.env', false)).toBe(true);
    expect(t('config/.env.local', false)).toBe(true);
    expect(t('.env.example', false)).toBe(false);
    expect(t('keys/a.pem', false)).toBe(true);
    expect(t('private', true)).toBe(true);
    expect(t('private/notes.md', false)).toBe(true);
    expect(t('src/private.ts', false)).toBe(false);
    expect(t('build/x.js', false)).toBe(true);
    expect(t('src/build/x.js', false)).toBe(false);
  });
});

describe('project tools', () => {
  it('refuses escapes, symlinks out, absolute paths and restricted files', () => {
    expect(() => tools.readFile('p', '../etc/passwd')).toThrow();
    expect(() => tools.readFile('p', '/etc/passwd')).toThrow('relative');
    expect(() => tools.readFile('p', 'escape/secret.txt')).toThrow('outside the project');
    expect(() => tools.readFile('p', '.env')).toThrow('restricted');
    expect(() => tools.readFile('p', 'deploy.pem')).toThrow('restricted');
    expect(() => tools.readFile('p', 'private/notes.md')).toThrow('restricted');
    expect(() => tools.readFile('p', 'logo.png')).toThrow('binary');
    expect(read('.env.example').text).toContain('API_KEY=');
  });

  it('reads numbered, bounded pages and masks secrets', () => {
    const page = read('src/big.ts', 1);
    expect(page.total_lines).toBe(1000);
    expect(page.end_line).toBe(400);
    expect(page.next_start_line).toBe(401);
    expect(page.text.split('\n')[0]).toBe('1\tline 1 reward');
    const later = read('src/big.ts', 990, 2000);
    expect(later.end_line).toBe(1000);
    expect(later.next_start_line).toBeNull();
    const listing = tools.listDir('p', '');
    expect(listing.entries).toContain('src/');
    expect(listing.entries).not.toContain('.env');
    expect(listing.entries).not.toContain('private/');
  });

  it('searches with pagination, globs and the same restrictions', async () => {
    const first = await tools.searchCode('p', { query: 'reward', max_results: 5 });
    expect(first.matches).toHaveLength(5);
    expect(first.next_cursor).toBe(5);
    expect(first.matches.every((m) => !m.path.startsWith('private/'))).toBe(true);
    const scoped = await tools.searchCode('p', { query: 'reward', glob: 'src/ads.ts' });
    expect(scoped.matches.map((m) => m.path)).toEqual(['src/ads.ts']);
    const secret = await tools.searchCode('p', { query: 'API_KEY' });
    expect(secret.matches.map((m) => m.path)).toEqual(['.env.example']);
    const regex = await tools.searchCode('p', { query: 'onAd\\w+', regex: true });
    expect(regex.matches[0]?.text).toContain('onAdClosed');
    await expect(tools.searchCode('p', { query: '(', regex: true })).rejects.toThrow('invalid');
  });

  it('reports git status and paged diffs without restricted files', async () => {
    const status = await tools.gitStatus('p');
    expect(status.branch).toBe('main');
    expect(status.files).toEqual([{ path: 'src/ads.ts', status: '.M' }]);
    expect(status.restricted_files).toBe(1);
    const diff = await tools.gitDiff('p', {});
    expect(diff.files.map((f) => f.path)).toEqual(['src/ads.ts']);
    expect(diff.files[0]?.patch).toContain('+  reward(true);');
    const committed = await tools.gitDiff('p', { base_ref: 'HEAD' });
    expect(committed.total_files).toBe(1);
    await expect(tools.gitDiff('p', { base_ref: '--output=/tmp/x' })).rejects.toThrow(
      'invalid ref',
    );
  });

  it('summarizes the project compactly', async () => {
    const ctx = await tools.context('p');
    expect(ctx.stack[0]).toContain('node (demo)');
    expect(ctx.git?.branch).toBe('main');
    expect(ctx.top_level).not.toContain('.env');
  });
});
