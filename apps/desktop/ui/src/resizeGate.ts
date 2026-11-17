/**
 * A pane drag is ONE resize, not thirty.
 *
 * Every SIGWINCH makes claude's TUI redraw its frame, and a redraw that lands
 * while the terminal is reflowing its scrollback leaves the previous frame
 * stranded at the old width (claude erases by cursor-relative row count, which
 * reflow has just invalidated). That debris can never widen back, because it
 * is hard-wrapped text, not a wrapped line. iTerm does exactly the same thing —
 * it is claude's redraw, not the emulator.
 *
 * We cannot stop the one repaint a resize owes us, but we can stop the drag
 * from buying a dozen. Terminals hold their refit until the mouse comes up.
 */
let depth = 0;
const waiting = new Set<() => void>();

export function beginDrag(): void {
  depth++;
}

export function endDrag(): void {
  depth = Math.max(0, depth - 1);
  if (depth > 0) return;
  const pending = [...waiting];
  waiting.clear();
  for (const fn of pending) fn();
}

export function isDragging(): boolean {
  return depth > 0;
}

/** a drag whose mouseup went missing (cmd-tab mid-drag) must not freeze
 *  every terminal's refit forever */
const STUCK_DRAG_MS = 3000;

/** Run `fn` as soon as no drag is in flight (immediately if none is). */
export function afterDrag(fn: () => void): void {
  if (depth === 0) {
    fn();
    return;
  }
  waiting.add(fn);
  setTimeout(() => {
    if (!waiting.delete(fn)) return;
    fn();
  }, STUCK_DRAG_MS);
}
