import { describe, expect, it } from 'vitest';
import { findImagePaths } from './imagePaths';

const CWD = '/Users/me/projects/app';

describe('pictures an answer refers to', () => {
  it('takes an absolute path whole', () => {
    expect(findImagePaths('written to /tmp/out/chart.png ok')).toEqual(['/tmp/out/chart.png']);
  });

  it('keeps the ~ — the backend expands it, a bare slash would be a root path', () => {
    expect(findImagePaths('saved ~/Documents/x.png')).toEqual(['~/Documents/x.png']);
  });

  it('resolves a relative path against the session cwd', () => {
    // the reported case: the whole path must survive, not the tail after
    // its first inner slash
    expect(findImagePaths('存到 `AppStore/v2/preview-all-39.png`', CWD)).toEqual([
      `${CWD}/AppStore/v2/preview-all-39.png`,
    ]);
  });

  it('drops a relative path when there is no cwd to resolve it against', () => {
    expect(findImagePaths('存到 AppStore/v2/preview.png')).toEqual([]);
  });

  it('leaves a remote url alone', () => {
    expect(findImagePaths('see https://example.com/logo.png', CWD)).toEqual([]);
  });

  it('ignores a bare filename — in prose that is a word, not a picture', () => {
    expect(findImagePaths('the icon.png asset', CWD)).toEqual([]);
  });

  it('finds several, without repeats', () => {
    expect(findImagePaths('/a/x.png and /a/x.png and /b/y.jpg')).toEqual(['/a/x.png', '/b/y.jpg']);
  });

  it('stops at the closing backtick or quote, not at the end of the line', () => {
    expect(findImagePaths('`/a/x.png` then text')).toEqual(['/a/x.png']);
  });
});
