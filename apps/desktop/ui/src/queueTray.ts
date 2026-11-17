/**
 * Stream view: messages parked in claude's queue live in a tray at the BOTTOM
 * of the conversation until claude takes them up — not at the point in the
 * scrollback where they were typed, which is not where they belong.
 *
 * Replays the queue records in order (see transcript-file.ts): an enqueue
 * joins the tray; a remove takes the named one (the queued_command record
 * after it shows the message); a popAll (Up pressed to edit) takes the named
 * one too — it comes back, if at all, as a new enqueue. What is left is the
 * tray.
 *
 * A dequeue carries NO text. It used to take the oldest entry, which is right
 * only while every enqueue in the file was eventually taken — and they are
 * not: a session that exits with messages still queued writes no record for
 * them, and after a resume those orphans sit at the head of the line for
 * good. Every later dequeue then removed an orphan instead of the message
 * actually taken, the whole tray ran behind by that many, and a message
 * claude had already answered stayed "Queued" (color, 09-23: two orphans
 * from the day before). So a dequeue waits for the user record right after
 * it — that one says what left — and falls back to the oldest only when
 * nothing in the tray matches.
 */
export interface QueueTurn {
  text: string;
  role?: string;
  queued?: boolean;
  dequeued?: boolean;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** the words of a message, its markup dropped: an injected message is taken
 *  up with its tag rewritten — the `hop-chain="…"` attribute it was queued
 *  with is gone by the time it lands — so the tags cannot be compared */
const words = (s: string): string => norm(s.replace(/<[^>]*>/g, ' '));

export function splitQueue<T extends QueueTurn>(
  turns: readonly T[],
): { conversation: T[]; tray: T[] } {
  const conversation: T[] = [];
  const tray: T[] = [];
  // dequeues seen whose user record has not arrived yet
  let taken = 0;
  for (const t of turns) {
    if (t.queued) {
      tray.push(t);
    } else if (t.dequeued) {
      if (!t.text) taken += 1;
      else {
        const i = tray.findIndex((q) => norm(q.text) === norm(t.text));
        if (i >= 0) tray.splice(i, 1);
      }
    } else {
      conversation.push(t);
      if (taken > 0 && (t.role ?? 'user') === 'user') {
        taken -= 1;
        // an injected message is taken up wrapped ("Another Claude session
        // sent a message:\n<cross-session-message …>"), so containment,
        // not equality
        const body = words(t.text);
        const i = tray.findIndex((q) => {
          const w = words(q.text);
          return w ? body.includes(w) : norm(t.text).includes(norm(q.text));
        });
        tray.splice(i >= 0 ? i : 0, 1);
      }
    }
  }
  return { conversation, tray };
}
