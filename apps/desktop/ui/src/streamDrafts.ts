/**
 * What was typed into a session's stream composer but not sent.
 *
 * The stream view mounts per focused session, so switching sessions threw the
 * half-written message away with the component. Drafts live here instead: in
 * memory for the session switch (attachments too — their object URLs only mean
 * something in this page), and the text in localStorage so a reloaded webview
 * (a phone coming back from the background) still has it.
 */

export interface StreamDraft {
  text: string;
  attachments: { path: string; url: string }[];
}

const KEY = 'ateam.stream.draft.';
const drafts = new Map<string, StreamDraft>();

export function loadDraft(sessionId: string): StreamDraft {
  const mem = drafts.get(sessionId);
  if (mem) return mem;
  let text = '';
  try {
    text = localStorage.getItem(KEY + sessionId) ?? '';
  } catch {
    /* storage blocked — memory only */
  }
  return { text, attachments: [] };
}

export function saveDraft(sessionId: string, draft: StreamDraft): void {
  const empty = !draft.text && draft.attachments.length === 0;
  if (empty) drafts.delete(sessionId);
  else drafts.set(sessionId, draft);
  try {
    if (draft.text) localStorage.setItem(KEY + sessionId, draft.text);
    else localStorage.removeItem(KEY + sessionId);
  } catch {
    /* storage blocked — memory only */
  }
}
