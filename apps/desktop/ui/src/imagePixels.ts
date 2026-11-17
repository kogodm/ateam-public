/** Pure helpers for the image viewer's pixel readout / channel view (#17). */

export interface Channels {
  readonly r: boolean;
  readonly g: boolean;
  readonly b: boolean;
  readonly a: boolean;
}
export const ALL_CHANNELS: Channels = { r: true, g: true, b: true, a: true };

export function hasAlpha(px: Uint8ClampedArray): boolean {
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) return true;
  return false;
}

/** RGBA at pixel (x, y) — undefined when off-image. */
export function sampleAt(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): readonly [number, number, number, number] | undefined {
  if (x < 0 || y < 0 || x >= width || y >= height) return undefined;
  const i = (y * width + x) * 4;
  return [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0, px[i + 3] ?? 0];
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0').toUpperCase();
/** `#RRGGBB` for opaque pixels, `#RRGGBBAA` otherwise */
export function hexOf([r, g, b, a]: readonly [number, number, number, number]): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a === 255 ? '' : hex2(a)}`;
}

/** New pixel buffer with the disabled channels zeroed; A off = fully opaque. */
export function applyChannels(px: Uint8ClampedArray, ch: Channels): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(px.length));
  out.set(px);
  for (let i = 0; i < out.length; i += 4) {
    if (!ch.r) out[i] = 0;
    if (!ch.g) out[i + 1] = 0;
    if (!ch.b) out[i + 2] = 0;
    if (!ch.a) out[i + 3] = 255;
  }
  return out;
}

/** element-relative pointer position → integer image pixel. The element's
 *  bounding rect already includes the zoom/pan transform, so the mapping is
 *  a plain proportion regardless of how the image is scaled on screen. */
export function pointerToPixel(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: Math.floor(((clientX - rect.left) / rect.width) * width),
    y: Math.floor(((clientY - rect.top) / rect.height) * height),
  };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
