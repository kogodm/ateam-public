import { existsSync, statSync } from 'node:fs';

const MARKER_RE = /ATEAM_HANDOFF_WRITTEN=\s*["'`]?([^\s"'`<>]+)/g;
const EXTENSION_RE = /\.[A-Za-z0-9]{1,8}/g;

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The existing file a marker candidate names. A wrapped marker is redrawn
 *  with cursor moves, so the screen text that follows it lands glued onto the
 *  path ("….mdChanneling…running"); when the whole candidate is not a file,
 *  fall back to the longest prefix that ends in an extension and is. */
function resolveCandidate(raw: string): string | undefined {
  const candidate = raw.replace(/[.,;:!?)\]>'"`]+$/, '');
  if (candidate.includes('<') || candidate.includes('>')) return undefined;
  if (!candidate.startsWith('/')) return undefined;
  if (isFile(candidate)) return candidate;
  // glued text can extend the extension too (".mdChanne"), so try each length
  const ends = [...candidate.matchAll(EXTENSION_RE)].flatMap((m) =>
    Array.from({ length: m[0].length - 1 }, (_, k) => m.index + 2 + k),
  );
  for (const end of ends.sort((a, b) => b - a)) {
    const prefix = candidate.slice(0, end);
    if (isFile(prefix)) return prefix;
  }
  return undefined;
}

/** The handoff doc path claude announced in the watched output, or undefined.
 *  Reads the text as-is and with wrapped lines rejoined (a narrow pane breaks
 *  the ~90 character marker line), and accepts only a path that is a file. */
export function findHandoffMarker(window: string): string | undefined {
  const joined = window.replace(/[\r\n]+[ \t]*/g, '');
  for (const view of [window, joined]) {
    for (const m of view.matchAll(MARKER_RE)) {
      const found = m[1] ? resolveCandidate(m[1]) : undefined;
      if (found) return found;
    }
  }
  return undefined;
}
