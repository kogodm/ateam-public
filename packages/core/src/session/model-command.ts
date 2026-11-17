/**
 * What a `/model` command's own output says the session switched to.
 *
 * The session's model is normally read off the last assistant record
 * (`message.model`), which is the truth about what ANSWERED. But a `/model`
 * run writes no assistant record at all — only the local-command records the
 * CLI logs — so between the switch and the next answer the transcript's
 * newest model field is the OLD model, and the UI shows a model the session
 * has already left. This reads the switch itself.
 *
 * That `/model` applies to the RUNNING session (and not only to "new
 * sessions", which is all its message mentions) was measured, not assumed:
 * across the transcripts on this machine, 38 of the 39 `/model` outputs that
 * have a following assistant record are answered by exactly the model named.
 */

/** ESC [ … m — the CLI bolds the model name inside its own output. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real ANSI escapes is the point
const ANSI = /\u001b\[[0-9;]*m/g;
const FAMILY = /^(opus|sonnet|haiku|fable|mythos)\s*([0-9]+(?:\.[0-9]+)?)$/;

/** The model id a `/model` output names, '' when the text is not one or names
 *  something we cannot turn into an id (e.g. "Default (recommended)" — the
 *  caller then keeps reading back for the last model that actually answered).
 *
 *  Only a `<local-command-stdout>` counts: prose quoting "Set model to" is
 *  exactly what a conversation ABOUT this feature contains, and it must not
 *  rename the session's model. */
export function modelIdFromSetLine(text: string): string {
  // The whole record must BE the command's output: a message that merely
  // quotes one (this feature's own tests and commit message do) must not
  // rename the session's model.
  if (!text.trimStart().startsWith('<local-command-stdout>')) return '';
  if (!text.includes('Set model to')) return '';
  const m = /Set model to\s*`?([^`\n<]+)/.exec(text.replace(ANSI, ''));
  if (!m?.[1]) return '';
  const label = m[1]
    .replace(/`/g, '')
    .replace(/\s+and saved.*$/i, '')
    .replace(/\([^)]*\)/g, '') // "(1M context)", "(default)"
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '') // a "[1m]" context suffix on a raw id
    .trim();
  if (!label) return '';
  if (label.startsWith('claude-')) return label; // already an id
  const fam = FAMILY.exec(label);
  if (!fam) return '';
  return `claude-${fam[1]}-${(fam[2] ?? '').replace('.', '-')}`;
}
