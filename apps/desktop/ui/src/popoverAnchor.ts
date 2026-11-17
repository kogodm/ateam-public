/**
 * Where a popover that has been portalled to <body> should sit so it still
 * reads as hanging off its trigger. Pure arithmetic, kept out of the
 * component: a panel that lands off-screen looks exactly like a panel that
 * did not open, which is a bug this codebase has now shipped twice.
 */

export interface Anchor {
  /** viewport px from the top — the panel is position:fixed */
  top: number;
  /** viewport px from the right edge */
  right: number;
}

/** Anchor `rect`'s bottom-right corner, with a gap, kept inside the viewport
 *  by at least `edge` on the right (a trigger flush to the screen edge would
 *  otherwise hang a rounded panel half off it). */
export function popoverAnchor(
  rect: { bottom: number; right: number },
  viewportWidth: number,
  gap = 8,
  edge = 8,
): Anchor {
  return {
    top: Math.round(rect.bottom + gap),
    right: Math.max(edge, Math.round(viewportWidth - rect.right)),
  };
}
