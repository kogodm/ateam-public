import { describe, expect, it } from 'vitest';
import { localImageSources, toLocalPath, withInlinedImages } from './htmlAssets';

describe('html preview images', () => {
  const page =
    '<td><img src="out/portrait_photo.png"></td><img class="x" src=\'../a b.jpg\'><img src="https://x/y.png"><img src="data:image/png;base64,AA">';
  it('finds the local pictures, resolved against the page (photo2level report, 09-18)', () => {
    const m = localImageSources(page, '/Users/me/color/experiments/photo2level/report.html');
    expect([...m.entries()]).toEqual([
      ['out/portrait_photo.png', '/Users/me/color/experiments/photo2level/out/portrait_photo.png'],
      ['../a b.jpg', '/Users/me/color/experiments/a b.jpg'],
    ]);
  });
  it('swaps only those for data URLs', () => {
    const out = withInlinedImages(
      page,
      new Map([['out/portrait_photo.png', 'data:image/jpeg;base64,QQ']]),
    );
    expect(out).toContain('<img src="data:image/jpeg;base64,QQ">');
    expect(out).toContain('src="https://x/y.png"');
    expect(out).toContain("src='../a b.jpg'");
  });
  it('inlines posters as images without sending video sources to thumbnails', () => {
    const html = '<video poster="cover.jpg" src="clip.mp4"><source src="alternate.webm"></video>';
    expect([...localImageSources(html, '/report/view.html')]).toEqual([
      ['cover.jpg', '/report/cover.jpg'],
    ]);
    expect(
      withInlinedImages(html, new Map([['cover.jpg', 'data:image/jpeg;base64,AA']])),
    ).toContain('poster="data:image/jpeg;base64,AA"');
  });
  it('resolves encoded local paths while excluding non-file schemes', () => {
    expect(toLocalPath('../blackbg_motion/idle_calm_0.mp4', '/work/b02/idle_candidates')).toBe(
      '/work/b02/blackbg_motion/idle_calm_0.mp4',
    );
    expect(toLocalPath('file:///a%20b/clip.mov#t=1', '/report')).toBe('/a b/clip.mov');
    for (const src of [
      'https://x/video.mp4',
      '//x/a',
      'blob:x',
      'data:video/mp4,AA',
      'javascript:x',
      'ftp://x',
    ]) {
      expect(toLocalPath(src, '/report')).toBeNull();
    }
  });
});
