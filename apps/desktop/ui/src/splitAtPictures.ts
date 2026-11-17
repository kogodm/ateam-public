import { findImagePaths } from './imagePaths';
import { marked } from './markdown';

export interface DocPart {
  /** markdown for this run of blocks */
  md: string;
  /** pictures this run names, in the order it names them */
  images: string[];
}

/**
 * An answer's markdown, cut so each picture can be drawn WHERE IT IS
 * MENTIONED instead of after the whole message.
 *
 * Every picture used to be appended at the bottom, so an answer that opened
 * with "the comparison is in `daily/gpt_color_disney.png`" and then spent ten
 * lines on a table and its reading put the picture below all of it — the one
 * thing the sentence was pointing at was the furthest thing from it.
 *
 * The split is at BLOCK boundaries (a paragraph, a table, a list), never
 * inside one: a picture is as wide as the column, and dropped mid-sentence it
 * would break the line it interrupts. So a block that names a picture is
 * followed by that picture, and the next block starts a new part.
 *
 * Blocks are marked's own tokens and each part is re-parsed from the `raw`
 * source they carry, which reconstructs the original text exactly — the view
 * keeps calling `marked.parse` on markdown, and nothing has to be sliced out
 * of rendered HTML.
 *
 * A picture named twice is drawn once, at its first mention.
 */
export function splitAtPictures(text: string, cwd?: string): DocPart[] {
  let tokens: { raw: string }[];
  try {
    tokens = marked.lexer(text);
  } catch {
    return [{ md: text, images: [] }];
  }
  const parts: DocPart[] = [];
  const seen = new Set<string>();
  let buf = '';
  for (const tok of tokens) {
    buf += tok.raw;
    const found = findImagePaths(tok.raw, cwd).filter((p) => !seen.has(p));
    if (found.length === 0) continue;
    for (const p of found) seen.add(p);
    parts.push({ md: buf, images: found });
    buf = '';
  }
  // the tail after the last picture — and, when there was none, the whole
  // message, which is the common case and must come back untouched
  if (buf.trim() || parts.length === 0) parts.push({ md: buf, images: [] });
  return parts;
}
