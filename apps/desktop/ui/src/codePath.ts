/**
 * Inline code that names a file — "`/Users/…/report.html`" — is how claude
 * points at what it made, and it was dead text in the stream: not a link, so
 * nothing to click. A code span is taken as a path when it is absolute
 * (`/…`, `~/…`) or relative with a folder AND an extension
 * (`apps/ui/src/StreamView.tsx`) — tight enough that `npm run build` or
 * `a/b` never light up. A trailing `:12` / `:12:3` (a line) is kept apart.
 */
const PATH_RE =
  /^(?:~?\/[^\s`<>"']+|(?:\.{1,2}\/)?[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?$/;

/** a web address written as inline code — `http://localhost:5173/` */
export function codeUrl(text: string): string | null {
  const t = text.trim();
  return /^https?:\/\/[^\s`<>"']+$/i.test(t) ? t : null;
}

export function codePath(text: string): { path: string; line?: number } | null {
  const t = text.trim();
  if (!t || t.length > 400 || t === '/' || /\s/.test(t) || !PATH_RE.test(t)) return null;
  const m = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(t);
  const path = m?.[1] ?? t;
  if (!/[\w.]/.test(path.replace(/^~?\//, ''))) return null;
  return m?.[2] ? { path, line: Number(m[2]) } : { path };
}

/** marked's `<code>…</code>` (not inside <pre>) → marked as a clickable path */
export function markCodePaths(html: string): string {
  return html.replace(/(?<!<pre>)<code>([^<]*)<\/code>/g, (whole, inner: string) =>
    codePath(decode(inner)) || codeUrl(decode(inner))
      ? `<code class="sv-path" title="Open">${inner}</code>`
      : whole,
  );
}

const decode = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
