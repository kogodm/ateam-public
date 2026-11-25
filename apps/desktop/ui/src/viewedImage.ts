import { toLocalPath } from './htmlAssets';
import { findImagePaths } from './imagePaths';

/** Basename for the Codex-style "Viewed image <name>" summary line. */
export function viewedImageBasename(path: string): string {
  const clean = path.replace(/[\\/]+$/, '');
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

/**
 * Local filesystem path for a Codex ImageView / view_image tool card.
 * Accepts a bare path, `file://…`, or exec JS that calls `tools.view_image`.
 */
export function viewedImagePath(
  text: string,
  cwd?: string,
  toolName?: string,
): string | null {
  const t = text.trim();
  if (!t) return null;

  const fromUri = (raw: string): string | null => {
    const s = raw.trim();
    if (!s) return null;
    if (/^file:\/\//i.test(s)) return toLocalPath(s, cwd || '/');
    if (!/\s/.test(s)) return findImagePaths(s, cwd)[0] ?? (/^[~/]/.test(s) ? s : null);
    return null;
  };

  const direct = fromUri(t);
  if (direct) return direct;

  // Nested: image(await tools.view_image({path: "…"})) or plain view_image({path})
  const m =
    /view_image\s*\(\s*\{\s*[^}]*?\bpath\s*:\s*(["'])([^"']+)\1/i.exec(t) ??
    /view_image\s*\(\s*\{\s*[^}]*?\bpath\s*:\s*`([^`]+)`/i.exec(t);
  if (m) {
    const raw = m[2] ?? m[1];
    if (raw) {
      const hit = fromUri(raw);
      if (hit) return hit;
      if (!/\s/.test(raw)) return cwd && !raw.startsWith('/') ? `${cwd.replace(/\/+$/, '')}/${raw}` : raw;
    }
  }

  // Only treat the whole input as a picture when this card is a view_image /
  // ImageView — a Bash that merely mentions a .png is not.
  if (toolName?.split('.').at(-1) === 'view_image') {
    const found = findImagePaths(t, cwd);
    return found[0] ?? null;
  }
  return null;
}

/** Codex TUI wording for a completed image inspection card. */
export function isViewedImageTool(toolName?: string, label?: string): boolean {
  const name = toolName?.split('.').at(-1)?.split('__').at(-1);
  if (name === 'view_image') return true;
  const l = (label ?? '').trim().toLowerCase();
  return l === 'viewed image' || l === 'view image';
}
