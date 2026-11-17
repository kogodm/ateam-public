import type { ProviderId } from '@ateam/contract';

const TITLE = 'messages to be submitted after next tool call';
const HINT = '(press esc to interrupt and send immediately)';
const ITEM = /^(\s*)↳\s?(.*)$/u;

export interface QueuePending {
  id: number;
  text: string;
  userTurns: number;
  stale?: boolean;
  queued?: boolean;
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function screenQueuedIds(
  pending: readonly QueuePending[],
  queue: readonly string[],
): Set<number> {
  const remaining = queue.map(normalize);
  const matched = new Set<number>();
  for (const message of pending) {
    const text = normalize(message.text);
    const index = text ? remaining.indexOf(text) : -1;
    if (index < 0) continue;
    remaining.splice(index, 1);
    matched.add(message.id);
  }
  return matched;
}

export function rememberScreenQueued<T extends QueuePending>(
  pending: T[],
  queue: readonly string[],
): T[] {
  const matched = screenQueuedIds(pending, queue);
  let changed = false;
  const next = pending.map((message) => {
    if (!matched.has(message.id) || (message.queued && !message.stale)) return message;
    changed = true;
    return { ...message, queued: true, stale: false };
  });
  return changed ? next : pending;
}

export function confirmedScreenPending<T extends QueuePending>(
  pending: readonly T[],
  recorded: string,
  matcher: (sent: string, recorded: string) => boolean = (sent, record) =>
    normalize(sent) !== '' && normalize(sent) === normalize(record),
): T | undefined {
  return pending.find((message) => matcher(message.text, recorded));
}

export function expireQueuePending<T extends QueuePending>(
  message: T,
  providerId: ProviderId | undefined,
  userTurns: number,
): T[] {
  if (providerId === 'codex' && message.queued) return [{ ...message, stale: false }];
  if (message.text.startsWith('/') || (providerId !== 'codex' && userTurns > message.userTurns))
    return [];
  return [{ ...message, stale: true }];
}

export function screenQueue(rows: readonly string[], providerId?: ProviderId): string[] {
  if (providerId !== 'codex') return [];
  let header = -1;
  for (let index = 0; index < rows.length; index += 1) {
    let candidate = '';
    for (let end = index; end < Math.min(index + 4, rows.length); end += 1) {
      const row = (rows[end] ?? '').trim();
      if (!row || ITEM.test(rows[end] ?? '')) break;
      candidate = `${candidate} ${end === index ? row.replace(/^[•●·]\s*/u, '') : row}`
        .trim()
        .toLowerCase();
      if (candidate === TITLE || candidate === `${TITLE} ${HINT}`) header = end;
      if (!`${TITLE} ${HINT}`.startsWith(candidate)) break;
    }
  }
  if (header < 0) return [];

  const messages: string[] = [];
  let contentColumn = 0;
  for (const row of rows.slice(header + 1)) {
    const item = ITEM.exec(row);
    if (item) {
      contentColumn = (item[1]?.length ?? 0) + 2;
      messages.push(item[2]?.trimEnd() ?? '');
      continue;
    }
    if (!row.trim() || messages.length === 0) break;
    const indentation = /^\s*/.exec(row)?.[0].length ?? 0;
    if (indentation < contentColumn || /^\s*[›❯>─━]/u.test(row)) break;
    const last = messages.length - 1;
    messages[last] += `\n${row.slice(contentColumn).trimEnd()}`;
  }
  return messages.filter((message) => message.trim() !== '');
}
