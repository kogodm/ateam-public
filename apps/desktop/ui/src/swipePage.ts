/**
 * The arithmetic behind flicking through the stream's pictures at fit size
 * (StreamView's full-screen viewer). Kept out of the component because it is
 * where the feel lives — how far a drag must go before it means anything,
 * which way it counts as going, what happens at the ends of the run — and
 * none of that is observable through a rendered component.
 */

export type SwipeAxis = 'x' | 'y';

/** Which way a drag is going, or null while it is still too small to mean
 *  anything. Deciding once and sticking to it is what keeps a slightly
 *  diagonal flick from wobbling between paging and scrolling. */
export function swipeAxis(dx: number, dy: number, slop = 8): SwipeAxis | null {
  if (Math.abs(dx) < slop && Math.abs(dy) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}

/** How far the picture follows the finger. Against the end of the run it
 *  gives only a fraction — the resistance says "nothing that way" without a
 *  word, and springs back on release. */
export function swipeFollow(dx: number, canPrev: boolean, canNext: boolean): number {
  const blocked = dx < 0 ? !canNext : !canPrev;
  return blocked ? dx * 0.3 : dx;
}

/** Which way to page when the finger lifts: 1 = the next picture, -1 = the
 *  previous one, 0 = spring back. The trip point scales with the screen but
 *  never demands more than a thumb's travel, so paging works one-handed on a
 *  large phone and still cannot fire from a tap's jitter. */
export function swipePage(
  dx: number,
  stageWidth: number,
  canPrev: boolean,
  canNext: boolean,
): -1 | 0 | 1 {
  const trip = Math.min(90, Math.max(24, stageWidth * 0.22));
  if (dx <= -trip) return canNext ? 1 : 0;
  if (dx >= trip) return canPrev ? -1 : 0;
  return 0;
}

export interface Picture {
  src: string;
  name: string;
}

/** The run of pictures a viewer opens onto, positioned at the one that was
 *  tapped. A picture the stream is not showing (nothing matched it) opens on
 *  its own rather than dropping the tap — better a viewer that cannot page
 *  than a tap that does nothing. */
export function pictureRun(
  all: readonly Picture[],
  tapped: Picture,
): { items: Picture[]; i: number } {
  const i = all.findIndex((p) => p.src === tapped.src);
  return i >= 0 ? { items: [...all], i } : { items: [tapped], i: 0 };
}
