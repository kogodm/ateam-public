/**
 * The mobile relay input registry.
 *
 * On touch devices the terminal is DISPLAY-ONLY: xterm's hidden textarea is
 * never focused and never holds text. All typing goes through one real,
 * visible <input> in the MobileKeys bar (the "relay"), which forwards
 * characters straight to the PTY. That input lives in App — it survives
 * session switches untouched, which is the point: every "first characters
 * swallowed / keyboard won't open / selection over invisible text" bug came
 * from juggling focus and value on a per-session hidden textarea.
 *
 * Term (the tap-zone handler) needs to focus/blur that input without prop
 * drilling through App; this registry is the wire.
 */
let el: HTMLInputElement | null = null;

export function registerRelayInput(input: HTMLInputElement | null): void {
  el = input;
}

/** Focus the relay (opens the soft keyboard). False when no relay is mounted
 *  (desktop layout) so callers can fall back. */
export function focusRelayInput(): boolean {
  if (!el) return false;
  el.focus();
  return true;
}

/** Blur the relay (dismisses the soft keyboard). */
export function blurRelayInput(): void {
  el?.blur();
}
