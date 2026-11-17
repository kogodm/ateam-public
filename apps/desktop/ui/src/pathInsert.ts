/** Custom drag MIME so a Files-panel drag is recognizable on drop (and
 *  distinguishable from arbitrary text drags). */
export const PATH_DRAG_MIME = 'application/x-ateam-path';

/**
 * Format a filesystem path for insertion into a session's input box. Paths
 * with spaces or shell-special chars are single-quoted (POSIX) so they arrive
 * as one clean token; a trailing space lets the next drop/token not glue on.
 */
export function formatPathForInput(path: string): string {
  const p = path.trim();
  if (!p) return '';
  const safe = /^[A-Za-z0-9_@%+=:,./~-]+$/.test(p);
  const quoted = safe ? p : `'${p.replace(/'/g, `'\\''`)}'`;
  return `${quoted} `;
}
