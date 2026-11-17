import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { ProviderId } from '@ateam/contract';
import type { NativeMigrationMessage } from './native-migration-types';
import { readCursorMigrationMessages } from './providers/cursor-session-import';

type RecordData = Record<string, unknown>;
const object = (value: unknown): RecordData =>
  value && typeof value === 'object' ? (value as RecordData) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function* records(path: string): Generator<RecordData> {
  const fd = openSync(path, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(256 * 1024);
  let pending = '';
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      pending += decoder.write(buffer.subarray(0, count));
      let consumed = 0;
      for (;;) {
        const boundary = pending.indexOf('\n', consumed);
        if (boundary < 0) break;
        const line = pending.slice(consumed, boundary);
        consumed = boundary + 1;
        if (!line.trim()) continue;
        yield JSON.parse(line) as RecordData;
      }
      pending = pending.slice(consumed);
      if (pending.length > 64 * 1024 * 1024)
        throw new Error('Session record exceeds migration limit');
    }
    pending += decoder.end();
    if (pending.trim()) {
      try {
        yield JSON.parse(pending) as RecordData;
      } catch {}
    }
  } finally {
    closeSync(fd);
  }
}

function parts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      const item = object(part);
      if (['text', 'input_text', 'output_text'].includes(text(item.type))) return text(item.text);
      if (item.type === 'thinking' || item.type === 'redacted_thinking') return '';
      if (item.type === 'tool_use')
        return `[Historical tool call: ${text(item.name)}]\n${JSON.stringify(item.input ?? {})}`;
      if (item.type === 'tool_result')
        return `[Historical tool result: ${text(item.tool_use_id)}]\n${parts(item.content)}`;
      if (item.type === 'image' || item.type === 'input_image')
        return '[Historical image: retained in the original session transcript; inspect that source if needed.]';
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function codexMessage(value: unknown, at: string): NativeMigrationMessage | undefined {
  const item = object(value);
  if (item.type === 'message' && (item.role === 'user' || item.role === 'assistant')) {
    const body = parts(item.content);
    return body ? { role: item.role, text: body, at } : undefined;
  }
  if (
    [
      'function_call',
      'custom_tool_call',
      'function_call_output',
      'custom_tool_call_output',
    ].includes(text(item.type))
  ) {
    const body = item.arguments ?? item.input ?? item.output ?? '';
    return {
      role: 'assistant',
      text: `[Historical tool record: ${text(item.name) || text(item.call_id)}]\n${typeof body === 'string' ? body : JSON.stringify(body)}`,
      at,
    };
  }
  return undefined;
}

export function readNativeMigrationMessages(
  providerId: ProviderId,
  path: string,
): NativeMigrationMessage[] {
  if (providerId === 'cursor') return readCursorMigrationMessages(path);
  if (providerId !== 'claude' && providerId !== 'codex')
    throw new Error(`Native migration is not supported for ${providerId}`);
  let messages: NativeMigrationMessage[] = [];
  const claudeChain = new Map<string, { parent: string; message?: NativeMigrationMessage }>();
  let lastClaudeId = '';
  let completeClaudeChain = true;
  for (const record of records(path)) {
    const at = text(record.timestamp) || new Date().toISOString();
    if (providerId === 'claude') {
      if (record.type === 'system' && record.subtype === 'compact_boundary') {
        messages = [];
        claudeChain.clear();
        lastClaudeId = '';
        completeClaudeChain = true;
        continue;
      }
      if (record.isSidechain) continue;
      const id = text(record.uuid);
      if (id) claudeChain.set(id, { parent: text(record.parentUuid) });
      const body = object(record.message);
      if (record.type !== 'user' && record.type !== 'assistant') continue;
      const content = parts(body.content);
      const message: NativeMigrationMessage | undefined =
        content && !record.isMeta ? { role: record.type, text: content, at } : undefined;
      if (message) messages.push(message);
      if (id) {
        claudeChain.set(id, { parent: text(record.parentUuid), message });
        lastClaudeId = id;
      } else if (message) completeClaudeChain = false;
    } else {
      const payload = object(record.payload);
      if (record.type === 'compacted') {
        if (Array.isArray(payload.replacement_history)) {
          messages = payload.replacement_history.flatMap((entry) => {
            const message = codexMessage(object(entry).item ?? entry, at);
            return message ? [message] : [];
          });
        } else {
          throw new Error('Cannot migrate a compacted Codex session without replacement history');
        }
      }
      if (record.type !== 'response_item') continue;
      const message = codexMessage(payload.item ?? payload, at);
      if (message) messages.push(message);
    }
  }
  if (providerId === 'claude' && lastClaudeId && completeClaudeChain) {
    const chain: NativeMigrationMessage[] = [];
    const visited = new Set<string>();
    let id = lastClaudeId;
    while (id && !visited.has(id)) {
      visited.add(id);
      const entry = claudeChain.get(id);
      if (!entry) break;
      if (entry.message) chain.unshift(entry.message);
      id = entry.parent;
    }
    messages = chain;
  }
  if (!messages.some((message) => message.role === 'user' && message.text.trim()))
    throw new Error('No model-visible user history is available for native migration');
  return messages;
}
