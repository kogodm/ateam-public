/**
 * An HTML preview runs in a sandboxed iframe from a string (srcDoc), so it has
 * no base URL: `<img src="out/photo.png">` resolved against nothing and every
 * picture of a generated report was a broken-image box. The pictures are
 * read through the core (scaled — a report can hold dozens) and inlined as
 * data: URLs before the page is shown. Only relative and file:// sources are
 * touched; http(s), data: and blob: are left as they are.
 */
const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;
const POSTER_RE = /(<video\b[^>]*?\bposter\s*=\s*)(["'])([^"']+)\2/gi;

export function localImageSources(html: string, htmlPath: string): Map<string, string> {
  const dir = htmlPath.slice(0, htmlPath.lastIndexOf('/'));
  const out = new Map<string, string>();
  for (const m of [...html.matchAll(IMG_SRC_RE), ...html.matchAll(POSTER_RE)]) {
    const src = m[3] ?? '';
    const abs = toLocalPath(src, dir);
    if (abs) out.set(src, abs);
  }
  return out;
}

export function toLocalPath(src: string, dir: string): string | null {
  const s = src.trim();
  if (/^(?:https?:|data:|blob:|\/\/)/i.test(s)) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(s) && !/^file:\/\//i.test(s)) return null;
  let p = s.replace(/[?#].*$/, '');
  if (/^file:\/\//i.test(p)) p = p.replace(/^file:\/\//i, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as written */
  }
  if (!p) return null;
  const joined = p.startsWith('/') ? p : `${dir}/${p}`;
  const parts: string[] = [];
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

/** the page with each local picture swapped for the data: URL it was read as */
export function withInlinedImages(html: string, dataUrls: Map<string, string>): string {
  const replace = (whole: string, head: string, q: string, src: string) => {
    const url = dataUrls.get(src);
    return url ? `${head}${q}${url}${q}` : whole;
  };
  return html.replace(IMG_SRC_RE, replace).replace(POSTER_RE, replace);
}
