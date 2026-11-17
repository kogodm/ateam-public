import { describe, expect, it } from 'vitest';
import { resolveDocLink } from './docLink';

const DOC = '/Users/me/color/docs/nextcloud/INDEX.md';

describe('resolveDocLink', () => {
  it('relative file links open next to the current document', () => {
    expect(resolveDocLink(DOC, 'nc_shard.md')).toEqual({
      kind: 'file',
      path: '/Users/me/color/docs/nextcloud/nc_shard.md',
    });
    expect(resolveDocLink(DOC, './webdav.md#etag')).toEqual({
      kind: 'file',
      path: '/Users/me/color/docs/nextcloud/webdav.md',
    });
    expect(resolveDocLink(DOC, '../OVERVIEW.md')).toEqual({
      kind: 'file',
      path: '/Users/me/color/docs/OVERVIEW.md',
    });
    expect(resolveDocLink(DOC, '%E5%88%86%E6%89%B9.md')).toEqual({
      kind: 'file',
      path: '/Users/me/color/docs/nextcloud/分批.md',
    });
  });
  it('absolute paths, directories and file:// stay local', () => {
    expect(resolveDocLink(DOC, '/etc/hosts')).toEqual({ kind: 'file', path: '/etc/hosts' });
    expect(resolveDocLink(DOC, '../sync/')).toEqual({
      kind: 'dir',
      path: '/Users/me/color/docs/sync',
    });
    expect(resolveDocLink(DOC, 'file:///tmp/a.md')).toEqual({ kind: 'file', path: '/tmp/a.md' });
  });
  it('web links leave the app; anchors stay in the page', () => {
    expect(resolveDocLink(DOC, 'https://x.com/a')).toEqual({
      kind: 'external',
      url: 'https://x.com/a',
    });
    expect(resolveDocLink(DOC, 'mailto:a@b.c')).toEqual({ kind: 'external', url: 'mailto:a@b.c' });
    expect(resolveDocLink(DOC, '#写-nc-前')).toEqual({ kind: 'anchor', id: '写-nc-前' });
    expect(resolveDocLink(DOC, '')).toEqual({ kind: 'none' });
  });
});
