import { describe, expect, it } from 'vitest';
import { popoverAnchor } from './popoverAnchor';

describe('popoverAnchor', () => {
  it('hangs the panel under the trigger, right edges aligned', () => {
    expect(popoverAnchor({ bottom: 44, right: 900 }, 1000)).toEqual({ top: 52, right: 100 });
  });
  it('keeps a panel off the screen edge when the trigger is flush to it', () => {
    expect(popoverAnchor({ bottom: 44, right: 1000 }, 1000)).toEqual({ top: 52, right: 8 });
  });
  it('rounds to whole pixels — fractional rects are the norm', () => {
    expect(popoverAnchor({ bottom: 43.6, right: 899.4 }, 1000)).toEqual({ top: 52, right: 101 });
  });
});
