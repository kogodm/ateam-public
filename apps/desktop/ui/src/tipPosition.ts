/**
 * Where a tip's popover goes, given the icon it belongs to. Pure so it can be
 * tested: a tip clipped by the edge of the window is a tip nobody can read.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const GAP = 6;
const MARGIN = 8;

/** Below the icon, left edges roughly aligned; shifted in from the right
 *  edge when it would overflow; above the icon when there is no room below. */
export function tipPosition(
  anchor: Rect,
  pop: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.max(MARGIN, Math.min(anchor.left - 10, viewport.width - pop.width - MARGIN));
  const below = anchor.bottom + GAP;
  const fitsBelow = below + pop.height <= viewport.height - MARGIN;
  const top = fitsBelow ? below : Math.max(MARGIN, anchor.top - GAP - pop.height);
  return { left: Math.round(left), top: Math.round(top) };
}
