import { useEffect, useState } from 'react';
import type { Rpc } from './rpc';

/** The `@…` being typed at the caret: `start` is the index of the `@`,
 *  `query` what follows it. An `@` counts only at the start or after
 *  whitespace — `a@b.com` is an address, not a file. `@@…` is a human
 *  mention (see humanMention.ts), so a second `@` does not open files. */
export function atTokenAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  const query = m[1] ?? '';
  const start = caret - query.length - 1;
  // the second `@` of `@@Name` would otherwise look like a file query
  if (start > 0 && text[start - 1] === '@') return null;
  return { start, query };
}

/** `text` with the token replaced by `@path` — a file gets a trailing space
 *  (done), a directory does not (keep going into it), as the CLI does. */
export function insertMention(
  text: string,
  caret: number,
  token: { start: number },
  path: string,
): { text: string; caret: number } {
  const ins = `@${path}${path.endsWith('/') ? '' : ' '}`;
  const next = text.slice(0, token.start) + ins + text.slice(caret);
  return { text: next, caret: token.start + ins.length };
}

/** Matches for the current token, fetched as it changes (80ms settle). */
export function useAtMatches(rpc: Rpc, dir: string | undefined, query: string | null): string[] {
  const [hits, setHits] = useState<string[]>([]);
  useEffect(() => {
    if (query === null || !dir) {
      setHits([]);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      void rpc
        .request('files.search', { dir, query, limit: 12 })
        .then((r) => {
          if (live) setHits(r.paths);
        })
        .catch(() => {
          if (live) setHits([]);
        });
    }, 80);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [rpc, dir, query]);
  return hits;
}
