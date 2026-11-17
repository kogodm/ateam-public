import { describe, expect, it } from 'vitest';
import { pictureRun, swipeAxis, swipeFollow, swipePage } from './swipePage';

describe('swipeAxis', () => {
  it('stays undecided until the finger has actually moved', () => {
    expect(swipeAxis(0, 0)).toBeNull();
    expect(swipeAxis(7, 7)).toBeNull();
  });
  it('takes the dominant direction', () => {
    expect(swipeAxis(30, 4)).toBe('x');
    expect(swipeAxis(-30, 4)).toBe('x');
    expect(swipeAxis(4, 30)).toBe('y');
  });
  it('calls a diagonal by its larger side rather than refusing', () => {
    expect(swipeAxis(20, 19)).toBe('x');
    expect(swipeAxis(19, 20)).toBe('y');
  });
});

describe('swipeFollow', () => {
  it('tracks the finger exactly when there is somewhere to go', () => {
    expect(swipeFollow(-60, true, true)).toBe(-60);
    expect(swipeFollow(60, true, true)).toBe(60);
  });
  it('resists at the end of the run, in the blocked direction only', () => {
    expect(swipeFollow(-60, true, false)).toBeCloseTo(-18);
    expect(swipeFollow(60, true, false)).toBe(60);
    expect(swipeFollow(60, false, true)).toBeCloseTo(18);
  });
});

describe('swipePage', () => {
  const W = 390; // a phone: 22% is ~86px, under the 90 cap
  it('ignores the jitter of a tap', () => {
    expect(swipePage(-6, W, true, true)).toBe(0);
    expect(swipePage(6, W, true, true)).toBe(0);
  });
  it('pages forward on a drag to the left and back on a drag to the right', () => {
    expect(swipePage(-120, W, true, true)).toBe(1);
    expect(swipePage(120, W, true, true)).toBe(-1);
  });
  it('stays put at the ends of the run', () => {
    expect(swipePage(-120, W, true, false)).toBe(0);
    expect(swipePage(120, W, false, true)).toBe(0);
  });
  it('never asks for more than a thumb of travel on a wide screen', () => {
    expect(swipePage(-91, 2000, true, true)).toBe(1);
  });
  it('still needs a real drag on a narrow one', () => {
    expect(swipePage(-20, 200, true, true)).toBe(0);
    expect(swipePage(-44, 200, true, true)).toBe(1);
  });
});

describe('pictureRun', () => {
  const all = [
    { src: 'blob:a', name: 'a.png' },
    { src: 'blob:b', name: 'b.png' },
    { src: 'blob:c', name: 'c.png' },
  ];
  it('opens on the tapped picture, keeping the whole run around it', () => {
    expect(pictureRun(all, all[1] as (typeof all)[0])).toEqual({ items: all, i: 1 });
  });
  it('opens a picture the stream is not showing on its own', () => {
    const stray = { src: 'blob:zzz', name: 'z.png' };
    expect(pictureRun(all, stray)).toEqual({ items: [stray], i: 0 });
  });
  it("copies the run rather than aliasing the caller's array", () => {
    const run = pictureRun(all, all[0] as (typeof all)[0]);
    expect(run.items).not.toBe(all);
  });
});
