import { describe, expect, it } from 'vitest';
import { applyChannels, hasAlpha, hexOf, pointerToPixel, sampleAt } from './imagePixels';

// 2×1 image: opaque red, half-transparent blue
const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 128]);

describe('image pixel helpers (#17)', () => {
  it('samples, formats and detects alpha', () => {
    expect(sampleAt(px, 2, 1, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(sampleAt(px, 2, 1, 1, 0)).toEqual([0, 0, 255, 128]);
    expect(sampleAt(px, 2, 1, 2, 0)).toBeUndefined();
    expect(hexOf([255, 0, 0, 255])).toBe('#FF0000');
    expect(hexOf([0, 0, 255, 128])).toBe('#0000FF80');
    expect(hasAlpha(px)).toBe(true);
    expect(hasAlpha(new Uint8ClampedArray([1, 2, 3, 255]))).toBe(false);
  });
  it('zeroes disabled channels and forces opacity when A is off', () => {
    const out = applyChannels(px, { r: false, g: true, b: true, a: false });
    expect([...out]).toEqual([0, 0, 0, 255, 0, 0, 255, 255]);
    expect(px[0]).toBe(255); // input untouched
  });
  it('maps pointer to pixel through the on-screen rect (zoom/pan baked in)', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 }; // 4× a 100×50 image
    expect(pointerToPixel(rect, 100, 50, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(pointerToPixel(rect, 499, 249, 100, 50)).toEqual({ x: 99, y: 49 });
    expect(pointerToPixel(rect, 302, 151, 100, 50)).toEqual({ x: 50, y: 25 });
  });
});
