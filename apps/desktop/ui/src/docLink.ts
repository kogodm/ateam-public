/**
 * Where a link in a rendered markdown document goes.
 *
 * The preview's HTML is plain DOM (marked output), so an unhandled click
 * navigates the WEBVIEW itself: a relative `nc_shard.md` replaced the whole
 * app, the boot splash came up, and the app reloaded back to where it was.
 * Every link therefore resolves to something the app handles itself.
 */
export type DocLink =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'dir'; path: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'none' };

function normalize(parts: string[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return `/${out.join('/')}`;
}

export function resolveDocLink(currentFile: string, rawHref: string): DocLink {
  const href = rawHref.trim();
  if (!href) return { kind: 'none' };
  if (href.startsWith('#')) return { kind: 'anchor', id: decodeSafe(href.slice(1)) };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    // file:// is a local path; every other scheme (http, mailto, …) leaves the app
    if (/^file:\/\//i.test(href)) {
      const p = decodeSafe(href.replace(/^file:\/\//i, '').replace(/[?#].*$/, ''));
      return p.endsWith('/')
        ? { kind: 'dir', path: normalize(p.split('/')) }
        : { kind: 'file', path: normalize(p.split('/')) };
    }
    return { kind: 'external', url: href };
  }
  const bare = decodeSafe(href.replace(/[?#].*$/, ''));
  if (!bare) return { kind: 'none' };
  const baseDir = currentFile.slice(0, currentFile.lastIndexOf('/'));
  const joined = bare.startsWith('/') ? bare : `${baseDir}/${bare}`;
  const path = normalize(joined.split('/'));
  return bare.endsWith('/') ? { kind: 'dir', path } : { kind: 'file', path };
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
