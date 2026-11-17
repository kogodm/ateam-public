import { describe, expect, it } from 'vitest';
import { type RowText, wrappedTokenAt } from './termWrap';

/** A row as buildLogicalLine returns it: one cell per character, 1-based. */
const row = (y: number, text: string): RowText => ({
  text,
  pos: [...text].map((_, i) => ({ x: i + 1, y })),
});
/** rows keyed by 0-based buffer index; row N (1-based) lives at index N-1 */
const buffer =
  (...rows: string[]) =>
  (index: number) =>
    rows[index] === undefined ? undefined : row(index + 1, rows[index] as string);

/** These three rows are anonymized from a live claude TUI (path lengths preserved) at 60 columns. */
const COLS = 60;
const LIVE = buffer(
  '  A) /Users/sample/PycharmProjects/ATeam/apps/desktop/ui/s',
  '  rc/deeply/nested/folder/TerminalLinkWrapProbe.tsx  B)',
  '  docs/remote/some/relative/deeper/path/that/is/long/WrapP',
  '  robe.md  C) 已写入',
  '  /Users/sample/PycharmProjects/ATeam/docs/OVERVIEW.md',
  '  里面是总览',
);
const FULL_A =
  '/Users/sample/PycharmProjects/ATeam/apps/desktop/ui/src/deeply/nested/folder/TerminalLinkWrapProbe.tsx';

describe('wrappedTokenAt — a live claude wrap', () => {
  it('assembles an absolute path from its head row', () => {
    const t = wrappedTokenAt(0, COLS, LIVE);
    expect(t?.text).toBe(FULL_A);
    expect(t?.start).toEqual({ x: 6, y: 1 });
    expect(t?.end).toEqual({ x: 51, y: 2 });
  });

  it('assembles the same path from its TAIL row — where most of the filename is', () => {
    expect(wrappedTokenAt(1, COLS, LIVE)?.text).toBe(FULL_A);
  });

  it('assembles a relative path whose head is not a recognisable link on its own', () => {
    expect(wrappedTokenAt(2, COLS, LIVE)?.text).toBe(
      'docs/remote/some/relative/deeper/path/that/is/long/WrapProbe.md',
    );
    expect(wrappedTokenAt(3, COLS, LIVE)?.text).toBe(
      'docs/remote/some/relative/deeper/path/that/is/long/WrapProbe.md',
    );
  });

  it('proposes nothing for a path that fit, even with prose on the next row', () => {
    expect(wrappedTokenAt(4, COLS, LIVE)).toBeNull(); // ends at col 54
    expect(wrappedTokenAt(5, COLS, LIVE)).toBeNull();
  });
});

describe('wrappedTokenAt — shapes', () => {
  it('still proposes a join for a complete path that ended exactly at the edge — the disk has to decide', () => {
    const rows = buffer(`  see ${'/x'.repeat(26)}.md`, '  里面写了总览 然后');
    expect(wrappedTokenAt(0, COLS, rows)?.text).toBe(`${'/x'.repeat(26)}.md里面写了总览`);
  });

  it('crosses a middle row that is nothing but path', () => {
    const mid = `  ${'m'.repeat(56)}`; // to col 58
    const rows = buffer(`  go ${'/a'.repeat(26)}b`, mid, '  tail.md then');
    const t = wrappedTokenAt(1, COLS, rows);
    expect(t?.text).toBe(`${'/a'.repeat(26)}b${'m'.repeat(56)}tail.md`);
    expect(t?.after).toBe(' then');
  });

  it('keeps what follows the tail, so a :line suffix is not lost', () => {
    const rows = buffer(`  ${'/p'.repeat(28)}`, '  x.ts:42 done');
    expect(wrappedTokenAt(1, COLS, rows)?.after).toBe(':42 done');
  });

  it('assembles a long path across many rows of a narrow pane, from any of them', () => {
    // 23 columns, as the terminal gets when the file preview is open beside it
    const narrow = 23;
    const path =
      '/tmp/ateam-wrap-e2e/deeply/nested/folder/structure/with/many/levels/TerminalLinkWrapProbe.tsx';
    const lines: string[] = [];
    let cur = '  A) ';
    for (const c of path) {
      if (cur.length === narrow - 2) {
        lines.push(cur);
        cur = '  ';
      }
      cur += c;
    }
    lines.push(`${cur} done`);
    expect(lines.length).toBeGreaterThan(4);
    const rows = buffer(...lines);
    for (let i = 0; i < lines.length; i++) expect(wrappedTokenAt(i, narrow, rows)?.text).toBe(path);
  });

  it('is null for a row that belongs to no wrap', () => {
    expect(wrappedTokenAt(0, COLS, buffer('short line', 'another'))).toBeNull();
    expect(wrappedTokenAt(9, COLS, LIVE)).toBeNull();
  });
});
