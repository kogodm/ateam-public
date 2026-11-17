/**
 * Image paths worth SHOWING inside an answer.
 *
 * Pure so it can be tested — this is the third bug in the same expression, and
 * every one of them had the same shape: the pattern demanded a leading slash,
 * so on a path that did not have one it started matching at the first INNER
 * slash and produced a root path that does not exist. The read then failed,
 * and a failed read renders nothing, so a chart the agent had just written
 * simply never appeared:
 *
 *   ~/Documents/x.png                 -> matched "/Documents/x.png"   (fixed)
 *   AppStore/v2/preview-all-39.png    -> matched "/v2/preview-all-39.png"
 *
 * A relative path is resolved against the session's cwd, which is the only
 * thing it could have meant. Without a cwd there is nothing to resolve it
 * against, so it is dropped rather than guessed at.
 */
const IMG = String.raw`[^\s\`'"()<>]*\.(?:png|jpe?g|gif|webp)`;
/** absolute, ~-relative, or relative WITH a directory part (a bare
 *  "logo.png" in prose is far more often a word than a picture) */
const IMG_PATH_RE = new RegExp(String.raw`(?:~\/|\/|(?:[\w.@%+-]+\/)+)${IMG}`, 'gi');

export function findImagePaths(text: string, cwd?: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMG_PATH_RE)) {
    const raw = m[0];
    const at = m.index ?? 0;
    // http://host/x.png is a link, not a file on this machine. The match
    // lands on the "//" (or just after the scheme's colon), so judge by what
    // comes immediately before it.
    if (/[:/]$/.test(text.slice(0, at))) continue;
    if (raw.startsWith('/') || raw.startsWith('~/')) {
      out.push(raw);
      continue;
    }
    if (!cwd) continue; // relative with nothing to resolve against
    out.push(`${cwd.replace(/\/+$/, '')}/${raw}`);
  }
  return [...new Set(out)];
}
