/**
 * The line a stream message is sent as: its text, then the uploaded files.
 *
 * Never lead with a path. claude treats a queued message whose text starts
 * with "/" as a slash command (2.1.272 `qIn`: `value.trim().startsWith("/")`),
 * and a slash command is not folded into the running turn — it waits for the
 * turn to end, while plain messages sent AFTER it are taken mid-turn. With the
 * upload path first, every message carrying a picture fell behind the ones
 * typed later: the order the user sent in was not the order handled.
 */
export const ATTACHED_PREFIX = 'Attached:';

/** an uploaded picture's path, as composePayload appends it */
export const UPLOAD_PATH_RE = /\S*\/\.ateam[^/\s]*\/uploads\/\S+\.(?:png|jpe?g|gif|webp|heic)/gi;
const IMAGE_TAG_RE = /\[Image #\d+\]/g;

/**
 * What a sent message and its transcript record have in common. claude turns
 * a pasted picture path into an `[Image #N]` placeholder at the FRONT of the
 * text, so "look at this /…/uploads/x.png" comes back as "[Image #2]look at
 * this" — comparing the raw texts never matched, and a message with a picture
 * showed twice (its optimistic bubble lived on beside the real one).
 */
export function messageBody(text: string): string {
  const s = text
    .replace(IMAGE_TAG_RE, ' ')
    .replace(UPLOAD_PATH_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s === ATTACHED_PREFIX ? '' : s;
}

/**
 * Whether a transcript record is the message this client sent.
 *
 * Usually the bodies are equal. But claude's input box can already hold text
 * when the stream types into it: after a restart, `--resume` puts the last
 * message it never answered back into the box (its `last-prompt` record), and
 * the stream — which does not show that box — types the next message after
 * it. What gets recorded is the leftover plus what was sent, so the
 * optimistic bubble never found its record and the message showed twice
 * (09-23: "stream模式不显示模型了" + "卡这里了"). A record that ENDS with what
 * was sent is it.
 */
export function sameMessage(sent: string, recorded: string): boolean {
  const s = messageBody(sent);
  const r = messageBody(recorded);
  return s === r || (s.length > 0 && r.endsWith(s));
}

export function composePayload(text: string, paths: readonly string[]): string {
  const files = paths.join(' ');
  if (!text) return files ? `${ATTACHED_PREFIX} ${files}` : '';
  return files ? `${text} ${files}` : text;
}
