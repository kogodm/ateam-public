import { describe, expect, it } from 'vitest';
import { tipPosition } from './tipPosition';

const icon = (left: number, top: number) => ({ left, top, right: left + 15, bottom: top + 15 });
const VIEW = { width: 1200, height: 800 };

describe('tipPosition', () => {
  it('opens below the icon, left-aligned with it', () => {
    expect(tipPosition(icon(300, 100), { width: 360, height: 120 }, VIEW)).toEqual({
      left: 290,
      top: 121,
    });
  });
  it('slides in from the right edge instead of running off it', () => {
    expect(tipPosition(icon(1150, 100), { width: 360, height: 120 }, VIEW).left).toBe(
      1200 - 360 - 8,
    );
  });
  it('never goes past the left edge', () => {
    expect(tipPosition(icon(2, 100), { width: 360, height: 120 }, VIEW).left).toBe(8);
  });
  it('flips above the icon when there is no room below', () => {
    expect(tipPosition(icon(300, 740), { width: 360, height: 120 }, VIEW).top).toBe(740 - 6 - 120);
  });
});
