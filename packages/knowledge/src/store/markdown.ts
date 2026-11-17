/**
 * Asset files are human-readable Markdown that is also machine-parseable:
 * line 1 is `<!--ateam <json> -->` (lossless metadata, robust to parse),
 * the rest is a human-friendly body. Markdown is the source of truth.
 */
const HEAD = '<!--ateam ';
const TAIL = ' -->';

export function serialize(meta: object, body: string): string {
  return `${HEAD}${JSON.stringify(meta)}${TAIL}\n${body.trimEnd()}\n`;
}

export function parseMeta<T>(content: string): T | null {
  const firstNl = content.indexOf('\n');
  const first = (firstNl === -1 ? content : content.slice(0, firstNl)).trim();
  if (!first.startsWith(HEAD) || !first.endsWith(TAIL)) return null;
  try {
    return JSON.parse(first.slice(HEAD.length, -TAIL.length)) as T;
  } catch {
    return null;
  }
}
