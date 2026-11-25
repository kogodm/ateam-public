import { describe, expect, it } from 'vitest';
import {
  isViewedImageTool,
  viewedImageBasename,
  viewedImagePath,
} from './viewedImage';

describe('viewedImagePath', () => {
  it('accepts a bare absolute path', () => {
    expect(viewedImagePath('/tmp/a.png')).toBe('/tmp/a.png');
  });

  it('strips file:// URIs the way Codex ImageView emits them', () => {
    expect(
      viewedImagePath(
        'file:///Users/me/art/avatar-happy-comparison.jpg',
      ),
    ).toBe('/Users/me/art/avatar-happy-comparison.jpg');
  });

  it('pulls the path out of nested tools.view_image exec JS', () => {
    expect(
      viewedImagePath(
        'const r = await tools.view_image({path:"/tmp/shot.png"}); image(r.image_url);',
        undefined,
        'exec',
      ),
    ).toBe('/tmp/shot.png');
  });

  it('does not treat an ordinary shell that mentions a png as a viewed image', () => {
    expect(viewedImagePath('cp a.png b.png && ls', '/work', 'Bash')).toBeNull();
  });
});

describe('viewedImageBasename / isViewedImageTool', () => {
  it('shows the file name Codex TUI puts after Viewed image', () => {
    expect(viewedImageBasename('/a/b/avatar-happy-comparison.jpg')).toBe(
      'avatar-happy-comparison.jpg',
    );
  });
  it('recognises view_image cards and Viewed image labels', () => {
    expect(isViewedImageTool('view_image')).toBe(true);
    expect(isViewedImageTool('functions.view_image')).toBe(true);
    expect(isViewedImageTool('exec', 'Viewed image')).toBe(true);
    expect(isViewedImageTool('Bash', 'Run command')).toBe(false);
  });
});
