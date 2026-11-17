/**
 * What the status line says when a path does not open — one wording for every
 * way into it (terminal links, the Files panel, the file view's "open with"),
 * so a failure reads the same wherever it came from.
 */

/** A path that was looked for and not found. Lists the places tried when
 *  that says something: for an absolute path the only place is the path. */
export function cantFindMessage(path: string, tried: readonly string[]): string {
  const relative = !path.startsWith('/') && !path.startsWith('~');
  if (tried.length === 0 || (!relative && tried.length === 1)) return `can't find ${path}`;
  const shown = tried.slice(0, 2).join(', ');
  const more = tried.length > 2 ? '…' : '';
  return `can't find ${path} (looked in ${tried.length} place${tried.length > 1 ? 's' : ''}: ${shown}${more})`;
}

/** A path that exists but the app handed it to refused it. */
export function openFailedMessage(path: string, err: unknown): string {
  const why =
    err instanceof Error ? err.message : typeof err === 'string' && err ? err : 'unknown error';
  return `can't open ${path}: ${why}`;
}
