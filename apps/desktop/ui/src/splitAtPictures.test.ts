import { describe, expect, it } from 'vitest';
import { splitAtPictures } from './splitAtPictures';

describe('splitAtPictures', () => {
  it('leaves a message with no picture in one piece', () => {
    const text = '# Title\n\nsome prose\n\n- a\n- b\n';
    expect(splitAtPictures(text)).toEqual([{ md: text, images: [] }]);
  });

  it('cuts after the block that names a picture, not at the end of the message', () => {
    const text =
      '上色跑完了，对比在 `/w/out/disney.png`。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n收尾的话。\n';
    const parts = splitAtPictures(text);
    expect(parts.map((p) => p.images)).toEqual([['/w/out/disney.png'], []]);
    expect(parts[0]?.md.trim()).toBe('上色跑完了，对比在 `/w/out/disney.png`。');
    expect(parts[1]?.md).toContain('| a | b |');
    expect(parts[1]?.md).toContain('收尾的话。');
  });

  it('puts each picture after its own block', () => {
    const parts = splitAtPictures('first /w/a.png\n\nsecond /w/b.png\n\ntail\n');
    expect(parts.map((p) => p.images)).toEqual([['/w/a.png'], ['/w/b.png'], []]);
  });

  it('draws a picture once, at its first mention', () => {
    const parts = splitAtPictures('see /w/a.png\n\nand again /w/a.png\n');
    expect(parts.map((p) => p.images)).toEqual([['/w/a.png'], []]);
  });

  it('resolves a relative path against the cwd, and drops it without one', () => {
    expect(splitAtPictures('out/a.png here', '/w/proj')[0]?.images).toEqual(['/w/proj/out/a.png']);
    expect(splitAtPictures('out/a.png here')[0]?.images).toEqual([]);
  });

  it('puts the source back together — nothing is lost at a cut', () => {
    const text = 'lead /w/a.png\n\n## head\n\nbody /w/b.png\n\ntail\n';
    expect(
      splitAtPictures(text)
        .map((p) => p.md)
        .join(''),
    ).toBe(text);
  });

  it('never returns an empty list, whatever it is handed', () => {
    expect(splitAtPictures('')).toEqual([{ md: '', images: [] }]);
  });
});
