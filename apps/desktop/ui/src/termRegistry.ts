import type { Terminal } from '@xterm/xterm';

/**
 * Every session's xterm, addressable by sessionId.
 *
 * The stream view needs the TUI's CURRENT SCREEN for one job: claude's own
 * pickers (/model, permission prompts, menus) live only in PTY bytes — they
 * never reach the transcript — so a stream-mode user could not answer them.
 * Term stays mounted for every session (hidden, still fed), so its xterm
 * already holds a correctly laid-out screen. Reading it here beats
 * re-emulating ANSI: a TUI positions text with escape sequences, and naive
 * stripping collapses the layout ("Opus5(1Mcontext)").
 */
const terms = new Map<string, Terminal>();

export function registerTerm(sessionId: string, term: Terminal): void {
  terms.set(sessionId, term);
}

export function unregisterTerm(sessionId: string): void {
  terms.delete(sessionId);
}

/** The visible screen as rows of plain text (trailing blanks trimmed). */
export function readScreen(sessionId: string): string[] {
  const term = terms.get(sessionId);
  if (!term) return [];
  const buf = term.buffer.active;
  const rows: string[] = [];
  for (let y = buf.baseY; y < buf.baseY + term.rows; y++) {
    const line = buf.getLine(y);
    rows.push(line ? line.translateToString(true) : '');
  }
  return rows;
}
