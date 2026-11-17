/**
 * Input that arrives while a session is handing off.
 *
 * Once the handoff prompt is in, the old session is on its way out: anything
 * typed into it is queued by claude behind the handoff turn and dies with the
 * PTY when the successor takes over. The desktop composer and terminal already
 * refuse input then, but a second client (the phone) learns of the handoff
 * only on its next poll — its keystrokes went straight into the dying session.
 *
 * So the server holds what a client types during the handoff and hands it to
 * the successor: finished messages are sent once the successor is up, and a
 * half-typed line is placed in its input box unsent. What is held is TEXT —
 * the keystrokes are replayed through a small line editor (typing, paste,
 * backspace, ^U, Enter). Navigation keys (arrows, Esc) and an Enter on an
 * empty line still reach the old session, so a permission prompt raised
 * while it writes the handoff document can still be answered.
 */

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export class HeldInput {
  readonly messages: string[] = [];
  private line = '';
  private inPaste = false;

  /** Feed one chunk of client input. Returns the part that must still go to
   *  the old session (navigation), or '' when everything was held. */
  feed(data: string): string {
    let pass = '';
    let i = 0;
    while (i < data.length) {
      if (this.inPaste) {
        const end = data.indexOf(PASTE_END, i);
        if (end < 0) {
          this.line += data.slice(i);
          return pass;
        }
        this.line += data.slice(i, end);
        this.inPaste = false;
        i = end + PASTE_END.length;
        continue;
      }
      if (data.startsWith(PASTE_START, i)) {
        this.inPaste = true;
        i += PASTE_START.length;
        continue;
      }
      const ch = data[i] as string;
      if (ch === '\x1b') {
        // Alt/Shift+Enter = newline inside the message
        if (data[i + 1] === '\r') {
          this.line += '\n';
          i += 2;
          continue;
        }
        // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point
        const seq = /^\x1b(?:\[[0-9;?]*[A-Za-z~]|O[A-Za-z])?/.exec(data.slice(i))?.[0] ?? ch;
        // arrows / Esc: the old session may be showing a picker — let them by
        // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point
        if (/^\x1b(?:\[[ABCD]|O[ABCD])?$/.test(seq)) pass += seq;
        i += seq.length;
        continue;
      }
      i++;
      if (ch === '\r' || ch === '\n') {
        if (this.line.trim()) this.messages.push(this.line.trim());
        else pass += ch; // Enter on nothing: a picker's confirm
        this.line = '';
      } else if (ch === '\x7f' || ch === '\b') {
        this.line = [...this.line].slice(0, -1).join('');
      } else if (ch === '\x15' || ch === '\x03') {
        this.line = ''; // ^U clears, ^C abandons
      } else if (ch === '\t' || ch >= ' ') {
        this.line += ch;
      }
    }
    return pass;
  }

  /** the half-typed line (not yet sent) */
  get partial(): string {
    return this.line;
  }

  get empty(): boolean {
    return this.messages.length === 0 && !this.line.trim();
  }
}

export interface HoldDeps {
  write: (sessionId: string, data: string) => void;
  /** subscribe to the session's next transcript turn; returns unsubscribe */
  onFirstTurn: (sessionId: string, cb: () => void) => () => void;
  setTimer: (cb: () => void, ms: number) => void;
}

/** after the successor shows its first turn (its TUI is up and working on the
 *  handoff doc), give it a moment, then type the held input in. No turn within
 *  a minute → deliver anyway rather than sit on the user's words. */
export const SETTLE_MS = 1000;
export const FIRST_TURN_TIMEOUT_MS = 60_000;
const ENTER_DELAY_MS = 150;

export function deliverHeld(held: HeldInput, sessionId: string, deps: HoldDeps): void {
  if (held.empty) return;
  let done = false;
  const go = (): void => {
    if (done) return;
    done = true;
    unsubscribe();
    deps.setTimer(() => typeIn(held, sessionId, deps), SETTLE_MS);
  };
  const unsubscribe = deps.onFirstTurn(sessionId, go);
  deps.setTimer(go, FIRST_TURN_TIMEOUT_MS);
}

/** same shape the composer uses: paste, then Enter as a SEPARATE write (one
 *  combined write leaves the text sitting in the box unsent) */
export function typeIn(held: HeldInput, sessionId: string, deps: HoldDeps): void {
  const steps: string[] = [];
  for (const m of held.messages) steps.push(`${PASTE_START}${m}${PASTE_END}`, '\r');
  if (held.partial.trim()) steps.push(`${PASTE_START}${held.partial}${PASTE_END}`);
  const next = (k: number): void => {
    const s = steps[k];
    if (s === undefined) return;
    deps.write(sessionId, s);
    deps.setTimer(() => next(k + 1), ENTER_DELAY_MS);
  };
  next(0);
}
