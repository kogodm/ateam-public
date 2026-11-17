import { describe, expect, it } from 'vitest';
import { STREAM_SIZE, availableStreamFonts, clampSize } from './streamFont';

describe('stream font size', () => {
  it('snaps to half pixels inside the allowed range', () => {
    expect(clampSize(14.2)).toBe(14);
    expect(clampSize(14.3)).toBe(14.5);
    expect(clampSize(3)).toBe(STREAM_SIZE.min);
    expect(clampSize(99)).toBe(STREAM_SIZE.max);
    expect(clampSize(Number.NaN)).toBe(STREAM_SIZE.base);
  });
});

describe('fonts offered', () => {
  it('only options with an installed font, plus Default and Mono', () => {
    const mac = new Set(['PingFang SC', 'Songti SC']);
    expect(availableStreamFonts((f) => mac.has(f)).map((f) => f.id)).toEqual([
      'system',
      'sans',
      'serif',
      'mono',
    ]);
    const bare = availableStreamFonts(() => false).map((f) => f.id);
    expect(bare).toEqual(['system', 'mono']);
    expect(availableStreamFonts((f) => f === 'KaiTi').map((f) => f.id)).toContain('kai');
  });
});
