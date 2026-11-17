import { SEG } from './termLinks';

/**
 * Hard-wrap geometry for terminal links, kept pure so it can be tested.
 *
 * claude's TUI wraps long lines itself, with a REAL newline and an indent, so
 * xterm's own soft-wrap chain never rejoins them. Measured on a live claude
 * (60 cols): a path cut mid-word fills its row to column cols-2 and carries on
 * two spaces in on the next row; a path that fits is moved to the next row
 * whole instead. So a long path can show up as
 *
 *     A) /Users/sample/PycharmProjects/ATeam/apps/desktop/ui/s     ← to col 58
 *     rc/deeply/nested/folder/TerminalLinkWrapProbe.tsx  B)
 *
 * and a relative one as `docs/…/long/WrapP` + `robe.md`, where the head is not
 * even recognisable as a link (no extension) and the tail alone points
 * nowhere. Geometry proposes the whole token from whichever row it is asked
 * about; it cannot tell a cut path from a complete one that merely ended at
 * the edge with prose below (path characters include CJK, so a wrapped Chinese
 * sentence reads as "more path"). The disk decides that, in Term.tsx.
 */

export interface Cell {
  x: number;
  y: number;
}

/** One row as Term's buildLogicalLine reads it: the text, trailing spaces
 *  trimmed, and for every code unit its 1-based cell. */
export interface RowText {
  text: string;
  pos: Cell[];
}

export interface WrappedToken {
  /** the token with every row's piece joined, indentation dropped */
  text: string;
  /** first and last cell it covers */
  start: Cell;
  end: Cell;
  /** anything right after it on its last row, e.g. ":42" */
  after: string;
}

/** within this many columns of the right edge counts as "ran to the edge" */
export const EDGE_SLACK = 2;
const TRAIL_RE = new RegExp(`[${SEG}/]+$`);
const LEAD_RE = new RegExp(`^[${SEG}/]+`);

const reachesEdge = (row: RowText, cols: number): boolean => {
  const last = row.pos[row.pos.length - 1];
  return last !== undefined && last.x >= cols - EDGE_SLACK;
};
const indentOf = (row: RowText): number => /^[ \t]*/.exec(row.text)?.[0].length ?? 0;
const leadRun = (row: RowText): string => LEAD_RE.exec(row.text.slice(indentOf(row)))?.[0] ?? '';
const trailToken = (row: RowText): string => TRAIL_RE.exec(row.text)?.[0] ?? '';
/** the row holds nothing but one path run (after its indent) */
const wholeRun = (row: RowText): boolean => {
  const run = leadRun(row);
  return run.length > 0 && indentOf(row) + run.length === row.text.length;
};

/** Does a path-looking token run off the end of `upper` and on at the start
 *  of `lower`? */
function handsDown(upper: RowText, lower: RowText, cols: number): boolean {
  return reachesEdge(upper, cols) && trailToken(upper) !== '' && leadRun(lower) !== '';
}

/**
 * The token crossing a hard wrap that touches row `index`, assembled across
 * every row it spans — whether `index` holds its head, its tail, or a middle —
 * or null when that row is not part of one.
 */
export function wrappedTokenAt(
  index: number,
  cols: number,
  /** the row at a 0-based buffer index, or undefined */
  rowAt: (index: number) => RowText | undefined,
  /** Generous on purpose: in a narrow pane (the file preview open beside the
   *  terminal, a phone) a 100-character path spans five or six rows, and a cap
   *  of four silently turned it back into an unclickable fragment. */
  maxRows = 16,
): WrappedToken | null {
  if (!rowAt(index)) return null;
  // up to the row the token starts on; every row passed on the way is a middle
  let head = index;
  for (let i = 1; i < maxRows; i++) {
    const up = rowAt(head - 1);
    const cur = rowAt(head);
    if (!up || !cur || !handsDown(up, cur, cols)) break;
    if (head !== index && !wholeRun(cur)) break;
    head--;
  }
  const first = rowAt(head);
  if (!first) return null;
  const headText = trailToken(first);
  if (!headText) return null;
  let text = headText;
  const start = first.pos[first.text.length - headText.length];
  let end: Cell | undefined;
  let after = '';
  let cur = first;
  let rowIndex = head;
  for (let i = 1; i < maxRows; i++) {
    const next = rowAt(rowIndex + 1);
    if (!next || !handsDown(cur, next, cols)) break;
    if (rowIndex !== head && !wholeRun(cur)) break; // a middle row must be all path
    const run = leadRun(next);
    const lastIdx = indentOf(next) + run.length - 1;
    text += run;
    end = next.pos[lastIdx];
    after = next.text.slice(lastIdx + 1);
    cur = next;
    rowIndex++;
    if (!(wholeRun(next) && reachesEdge(next, cols))) break; // ends on this row
  }
  if (!start || !end || rowIndex < index) return null; // single row, or `index` below it
  return { text, start, end, after };
}
