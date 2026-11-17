import { readFileSync } from 'node:fs';

/**
 * Messages the user queued in a claude session that claude never took up.
 *
 * Typing while claude is busy parks the message in its queue; the transcript
 * records that as `queue-operation` lines — `enqueue` (with the text), then
 * either `dequeue` (no text: the oldest queued message is taken), `remove`
 * (with the text: taken mid-turn) or `popAll` (with the text: pulled back into
 * the input box for editing). A handoff kills the old session the moment its document is
 * written, so whatever is still queued then dies with it — and the handoff
 * prompt itself, injected mid-turn, jumps ahead of the user's older messages
 * (2026-09-14: two feature requests vanished this way). The successor gets
 * them instead.
 *
 * Machine-injected entries (task notifications, Ateam's own prompts) are not
 * the user's words and are left out.
 */
export function unhandledQueuedMessages(lines: Iterable<string>): string[] {
  const pending: string[] = [];
  for (const line of lines) {
    if (!line.includes('"queue-operation"')) continue;
    let o: { type?: string; operation?: string; content?: unknown };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'queue-operation') continue;
    const body = typeof o.content === 'string' ? o.content : '';
    if (o.operation === 'enqueue' && body) pending.push(body);
    else if (o.operation === 'dequeue') pending.shift();
    else if (o.operation === 'remove' || o.operation === 'popAll') {
      const i = pending.indexOf(body);
      if (i >= 0) pending.splice(i, 1);
    }
  }
  return pending.map((b) => b.trim()).filter((b) => b && !isMachineMessage(b));
}

function isMachineMessage(body: string): boolean {
  return /^<[a-z-]+>/.test(body) || body.startsWith('[Ateam ');
}

/** same, read from a transcript file; [] when it cannot be read */
export function unhandledQueuedMessagesIn(path: string): string[] {
  try {
    return unhandledQueuedMessages(readFileSync(path, 'utf8').split('\n'));
  } catch {
    return [];
  }
}

/** the block appended to a successor's first message */
export function queuedCarryoverBlock(messages: readonly string[]): string {
  if (messages.length === 0) return '';
  return [
    '',
    '--- QUEUED MESSAGES ---',
    'The user sent these to the previous session while it was busy, and it never got to them before the handoff. They are still open — handle them after you have picked up the work, in this order.',
    ...messages.map((m, i) => `\n[${i + 1}]\n${m}`),
    '--- END QUEUED MESSAGES ---',
  ].join('\n');
}
