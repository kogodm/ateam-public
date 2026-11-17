import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let home: string;
let prevHome: string | undefined;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ateam-identity-'));
  prevHome = process.env.ATEAM_HOME;
  process.env.ATEAM_HOME = home;
});
afterAll(() => {
  if (prevHome === undefined) process.env.ATEAM_HOME = '';
  else process.env.ATEAM_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const {
  compactKeepFor,
  compactSaveFor,
  humanMetaDir,
  knowledgeSizeStatus,
  recallFor,
  recallNeedsReinjection,
  recallPrompt,
} = await import('./human-meta');
const { ensureHuman } = await import('./humans');

describe('the identity a session is given', () => {
  it('names the human and their role', () => {
    const p =
      recallPrompt({ meta: '', metaDir: '/meta', who: { name: 'Shaily', role: 'UI' } }) ?? '';
    expect(p).toContain('You are Shaily, the team’s UI.'.replace('’', "'"));
  });

  it('states the scope and the hand-back rule when duties are set', () => {
    const p =
      recallPrompt({
        meta: '',
        metaDir: '/meta',
        who: {
          name: 'Drawer',
          role: 'Art',
          duties: 'Artwork and image generation only.',
        },
      }) ?? '';
    expect(p).toContain('Artwork and image generation only.');
    expect(p).toContain('hand it back');
  });

  it('a human from before duties existed gets the identity line and no scope text', () => {
    const p =
      recallPrompt({ meta: '', metaDir: '/meta', who: { name: 'Weber', role: 'coder' } }) ?? '';
    expect(p).toContain('You are Weber');
    expect(p).not.toContain('responsible for');
    expect(p).not.toContain('hand it back');
  });

  it('still returns the knowledge index, and nothing at all when there is nothing to say', () => {
    const withMeta = recallPrompt({ meta: '- some-skill — does a thing', metaDir: '/meta' }) ?? '';
    expect(withMeta).toContain('some-skill');
    expect(recallPrompt({ meta: '', metaDir: '/meta' })).toBeUndefined();
  });
});

describe('the working method a project session is given', () => {
  it('tells it to delegate, and points the doc paths at THIS project', () => {
    const p =
      recallPrompt({ meta: '', metaDir: '/meta', projectDir: '/Users/me/projects/Tipsy' }) ?? '';
    expect(p).toContain('/Users/me/projects/Tipsy/docs/OVERVIEW.md');
    expect(p).toContain('子 agent');
    expect(p).not.toContain('{{DOCS_DIR}}'); // placeholder actually substituted
  });

  it('asks answers for a verdict backed by data — not a line and a path, not an essay', () => {
    // The first version told sessions to leave "only a one-line conclusion
    // and a doc path" in the conversation. Meant for the session's own
    // working context, it read as a rule for its answers, and every session
    // started replying like a chat-mode teammate. The user's rule since:
    // give the verdict, with the data behind it when there is data, and no
    // long explanations.
    const p = recallPrompt({ meta: '', metaDir: '/meta', projectDir: '/proj' }) ?? '';
    expect(p).not.toContain('只留一行结论');
    expect(p).toContain('给出判定');
    expect(p).toContain('支撑判定的数据');
  });

  it('comes after the knowledge index — the /clear hook truncates the tail', () => {
    const p =
      recallPrompt({
        meta: '- some-skill — does a thing',
        metaDir: '/meta',
        projectDir: '/proj',
      }) ?? '';
    expect(p.indexOf('some-skill')).toBeLessThan(p.indexOf('/proj/docs/OVERVIEW.md'));
  });

  it('is left out of a directory-less session, whose doc paths would be wrong everywhere', () => {
    const p = recallPrompt({ meta: '', metaDir: '/meta', knownDirs: ['/a', '/b'] }) ?? '';
    expect(p).toContain('/a');
    expect(p).not.toContain('OVERVIEW.md');
  });

  it('recallFor is the one assembler both injection points use', () => {
    const inProject = recallFor('h-1', { cwd: '/proj/x' }) ?? '';
    expect(inProject).toContain('/proj/x/docs/OVERVIEW.md');
    // directory-less: known dirs instead of a project's docs
    expect(recallFor('h-1', { cwd: '/proj/x', directoryless: true }) ?? '').not.toContain(
      'OVERVIEW.md',
    );
  });
});

describe('when a session gets the recall text printed back at it', () => {
  it('re-injects after /clear and on resume, but not at startup', () => {
    // measured on claude 2.1.268: --append-system-prompt is dropped by
    // --resume, so resume is the only way a running session ever sees a
    // prompt or a knowledge index written after it was born. At startup the
    // launch flag already carried it.
    expect(recallNeedsReinjection('clear')).toBe(true);
    expect(recallNeedsReinjection('resume')).toBe(true);
    expect(recallNeedsReinjection('startup')).toBe(false);
    expect(recallNeedsReinjection(undefined)).toBe(false);
  });

  it("re-injects after Claude Code's own compaction too (09-23)", () => {
    // a resumed session's recall lives only in its history — compaction
    // summarized it away and nothing put it back
    expect(recallNeedsReinjection('compact')).toBe(true);
  });
});

describe("what survives Claude Code's own compaction", () => {
  it('the summary is told to keep what was learned, pointing at the knowledge folder', () => {
    const h = ensureHuman({ name: 'Weber', role: 'coder' });
    const keep = compactKeepFor(h.id) ?? '';
    expect(keep).toContain('## Experience to keep');
    expect(keep).toContain(join(home, 'users'));
    expect(keep).not.toContain('{{META_DIR}}');
  });

  it('after it, the session is told to save that section before going on', () => {
    const h = ensureHuman({ name: 'Weber', role: 'coder' });
    const save = compactSaveFor(h.id) ?? '';
    expect(save).toContain('Experience to keep');
    expect(save).not.toContain('{{');
  });

  it('a session without a teammate has no knowledge folder, so gets neither', () => {
    expect(compactKeepFor('no-such-human')).toBeUndefined();
    expect(compactSaveFor('no-such-human')).toBeUndefined();
  });
});

describe('the knowledge folder, measured for the prompts that write to it', () => {
  const setup = (index: number, entries: Record<string, number>) => {
    const h = ensureHuman({ name: `Sized-${index}`, role: 'coder' });
    const dir = humanMetaDir(h.id);
    mkdirSync(join(dir, 'knowledge'), { recursive: true });
    writeFileSync(join(dir, 'meta.md'), 'x'.repeat(index));
    for (const [rel, n] of Object.entries(entries)) writeFileSync(join(dir, rel), 'y'.repeat(n));
    return h.id;
  };

  it('says nothing when everything is within the limits', () => {
    expect(knowledgeSizeStatus(setup(3_000, { 'knowledge/a.md': 5_000 }))).toBe('');
  });

  it('names an index over the limit, with its size, as the first thing to fix (09-23)', () => {
    const s = knowledgeSizeStatus(setup(11_388, {}));
    expect(s).toContain('11,388 characters');
    expect(s).toContain('Condense it FIRST');
  });

  it('lists oversized entries, largest first, to split when next touched', () => {
    const s = knowledgeSizeStatus(
      setup(1_000, {
        'knowledge/big.md': 31_391,
        'knowledge/mid.md': 7_000,
        'knowledge/ok.md': 500,
      }),
    );
    expect(s).toContain('knowledge/big.md (31,391), knowledge/mid.md (7,000)');
    expect(s).not.toContain('ok.md');
    expect(s).not.toContain('Condense');
  });

  it('reaches the prompt after a compaction', () => {
    const id = setup(9_000, {});
    expect(compactSaveFor(id)).toContain('9,000 characters');
  });
});
