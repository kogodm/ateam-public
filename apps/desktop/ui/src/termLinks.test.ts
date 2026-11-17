import { describe, expect, it } from 'vitest';
import { type LinkSpan, findLinks } from './termLinks';

/** compact view of a span: what gets underlined, and what we'd open */
const brief = (s: LinkSpan, text: string) => ({
  under: text.slice(s.start, s.end),
  kind: s.kind,
  target: s.target,
  ...(s.line !== undefined ? { line: s.line } : {}),
  ...(s.column !== undefined ? { column: s.column } : {}),
});
const links = (text: string) => findLinks(text).map((s) => brief(s, text));
const targets = (text: string) => findLinks(text).map((s) => s.target);

describe('findLinks — what counts as a link', () => {
  const cases: [name: string, text: string, want: string[]][] = [
    ['absolute path', 'wrote /Users/m/proj/out.md done', ['/Users/m/proj/out.md']],
    ['home-relative path', 'see ~/Downloads/shot.png', ['~/Downloads/shot.png']],
    ['relative path with extension', 'edit apps/desktop/ui/App.tsx now', ['apps/desktop/ui/App.tsx']],
    ['bare filename, known extension', 'created report.md for you', ['report.md']],
    ['CJK filename', '写好了 早停101~300不合规名单.md 了', ['早停101~300不合规名单.md']],
    ['http url', 'see https://example.com/a/b?c=1 for more', ['https://example.com/a/b?c=1']],
    ['url and path on one line', 'https://x.dev/y and src/a.ts', ['https://x.dev/y', 'src/a.ts']],
    ['several paths', 'a/b.ts and c/d.py', ['a/b.ts', 'c/d.py']],
  ];
  for (const [name, text, want] of cases) {
    it(name, () => expect(targets(text)).toEqual(want));
  }

  const rejected: [name: string, text: string][] = [
    ['a decimal number', 'took 7.5 seconds'],
    ['an abbreviation', 'e.g. this one'],
    ['a version number', 'bumped to v2.0 today'],
    ['a bare word with an unknown extension', 'the foo.zzz thing'],
    ['prose with no path at all', 'nothing to see here'],
  ];
  for (const [name, text] of rejected) {
    it(`rejects ${name}`, () => expect(targets(text)).toEqual([]));
  }
});

describe('findLinks — location suffixes (both forms codex is told to emit)', () => {
  it('parses :line', () => {
    expect(links('see src/app.ts:42 there')).toEqual([
      { under: 'src/app.ts:42', kind: 'path', target: 'src/app.ts', line: 42 },
    ]);
  });

  it('parses :line:column', () => {
    expect(links('at src/app.ts:42:8 exactly')).toEqual([
      { under: 'src/app.ts:42:8', kind: 'path', target: 'src/app.ts', line: 42, column: 8 },
    ]);
  });

  it('parses #Lline', () => {
    expect(links('in b/server/index.js#L10 here')).toEqual([
      { under: 'b/server/index.js#L10', kind: 'path', target: 'b/server/index.js', line: 10 },
    ]);
  });

  it('parses #LlineCcolumn', () => {
    expect(links('at b/x.js#L10C3 there')).toEqual([
      { under: 'b/x.js#L10C3', kind: 'path', target: 'b/x.js', line: 10, column: 3 },
    ]);
  });

  it('underlines the suffix but opens the bare path', () => {
    const [s] = findLinks('edit main.rs:12:5 now');
    expect(s?.target).toBe('main.rs');
    expect(s?.line).toBe(12);
    expect(s?.column).toBe(5);
  });

  it('a trailing colon with no number is punctuation, not a location', () => {
    expect(links('open src/app.ts: yes')).toEqual([
      { under: 'src/app.ts', kind: 'path', target: 'src/app.ts' },
    ]);
  });
});

describe('findLinks — backticked inline code (codex wraps file refs in it)', () => {
  it('accepts a directory, which bare prose would refuse', () => {
    expect(targets('look in `apps/desktop/ui` please')).toEqual(['apps/desktop/ui']);
  });

  it('accepts an unknown extension inside backticks', () => {
    expect(targets('open `notes/thing.mdx` now')).toEqual(['notes/thing.mdx']);
  });

  it('keeps the location suffix from inside the backticks', () => {
    expect(links('cited `sub/deep/nested.md:1` there')).toEqual([
      { under: 'sub/deep/nested.md:1', kind: 'path', target: 'sub/deep/nested.md', line: 1 },
    ]);
  });

  it('a backticked command is not a path', () => {
    expect(targets('run `git status` first')).toEqual([]);
  });

  it('a backticked identifier is not a path', () => {
    expect(targets('the `useEffect` hook')).toEqual([]);
  });

  it('does not double-report a path the prose rules already matched', () => {
    expect(targets('see `src/app.ts` now')).toEqual(['src/app.ts']);
  });
});

describe('findLinks — boundaries and overlaps', () => {
  it("does not link a URL's path part a second time", () => {
    expect(targets('https://example.com/docs/setup.md here')).toEqual([
      'https://example.com/docs/setup.md',
    ]);
  });

  it('trims sentence punctuation off the end', () => {
    expect(targets('wrote /tmp/out.md.')).toEqual(['/tmp/out.md']);
    expect(targets('(see src/a.ts)')).toEqual(['src/a.ts']);
  });

  it('keeps quotes out of the span', () => {
    expect(links('open "src/a.ts" now')).toEqual([
      { under: 'src/a.ts', kind: 'path', target: 'src/a.ts' },
    ]);
  });

  it('spans point at the right slice of the line', () => {
    const text = 'prefix /tmp/a.md suffix';
    const [s] = findLinks(text);
    expect(text.slice(s?.start, s?.end)).toBe('/tmp/a.md');
  });

  it('starts a path after the delimiter, not at it', () => {
    expect(links('ARG=/tmp/out.md rest')).toEqual([
      { under: '/tmp/out.md', kind: 'path', target: '/tmp/out.md' },
    ]);
  });

  // the old whitelist anchor (whitespace/quotes/brackets only) refused all of
  // these, which is most of how a path actually shows up in agent output
  const delimited: [string, string][] = [
    ['--out=/tmp/shot.png', '/tmp/shot.png'],
    ['cwd:/Users/m/proj', '/Users/m/proj'],
    ['→ apps/ui/App.tsx', 'apps/ui/App.tsx'],
    ['a|b/c.ts', 'b/c.ts'],
    ['[1] docs/readme.md', 'docs/readme.md'],
  ];
  for (const [text, want] of delimited) {
    it(`finds the path in ${text}`, () => expect(targets(text)).toEqual([want]));
  }

  it('still refuses a filename glued to the middle of a word', () => {
    expect(targets('myreport.md')).toEqual(['myreport.md']); // the whole token IS the name
    expect(targets('xreport.mdy')).toEqual([]); // not a filename at all
  });

  it('REGRESSION: a known extension must END the name, not just prefix it', () => {
    // run.jsonl used to link as run.json — a file that never exists
    expect(targets('tail run.jsonl now')).toEqual([]);
    expect(targets('open notes.md.bak')).toEqual([]);
    expect(targets('wrote notes.md.')).toEqual(['notes.md']); // sentence period
    expect(targets('edit App.tsx here')).toEqual(['App.tsx']); // longer ext still wins
  });

  it('finds a URL even glued to preceding text (prefixes like "see:" are common)', () => {
    expect(targets('see:https://y.dev/z')).toEqual(['https://y.dev/z']);
  });

  it('returns spans in positional order', () => {
    const out = findLinks('c/d.py then https://x.dev/a then e/f.ts');
    expect(out.map((s) => s.start)).toEqual([...out.map((s) => s.start)].sort((a, b) => a - b));
  });

  it('is empty for an empty line', () => {
    expect(findLinks('')).toEqual([]);
  });
});
