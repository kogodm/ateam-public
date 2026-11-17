/**
 * A line of someone else's output, fit for the app's own chrome.
 *
 * The app draws its icons as line strokes and never uses emoji. The one-line
 * summaries in the background panel, though, are borrowed text — a command's
 * last line, a sub-agent's latest step — and tools love to decorate those:
 * esbuild ends a build with "⚡ Done in 14ms". Shown as-is, that put an emoji
 * in the middle of the app's own panel. The emoji go; the words stay. The
 * full output, opened, is left exactly as the command printed it.
 */
// the joiner, variation selector and keycap that glue emoji together are
// listed apart: inside a character class they would read as one misleading
// "character" to a reader (and to the linter)
const PICTOGRAPH = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{200D}|\u{20E3}/gu;

export function plainLine(text: string): string {
  return text.replace(PICTOGRAPH, '').replace(/\s+/g, ' ').trim();
}
