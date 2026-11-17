import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readNativeMigrationMessages } from './native-migration-source';

const roots: string[] = [];
function fixture(records: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ateam-native-source-'));
  roots.push(root);
  const path = join(root, 'session.jsonl');
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return path;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native migration source history', () => {
  it('follows attachment and system parent links without importing their content', () => {
    const path = fixture([
      { type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'original request' } },
      {
        type: 'attachment',
        uuid: 'hook',
        parentUuid: 'u1',
        attachment: { type: 'hook_success', content: 'private hook payload' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'hook',
        message: { content: [{ type: 'text', text: 'first answer' }] },
      },
      { type: 'system', uuid: 'sys', parentUuid: 'a1', subtype: 'turn_duration' },
      { type: 'user', uuid: 'u2', parentUuid: 'sys', message: { content: 'latest request' } },
      {
        type: 'attachment',
        uuid: 'env',
        parentUuid: 'u2',
        attachment: { type: 'environment', content: 'source-only environment' },
      },
      {
        type: 'attachment',
        uuid: 'tokens',
        parentUuid: 'env',
        attachment: { type: 'total_tokens_reminder' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'tokens',
        message: { content: [{ type: 'text', text: 'latest answer' }] },
      },
    ]);
    expect(readNativeMigrationMessages('claude', path).map((message) => message.text)).toEqual([
      'original request',
      'first answer',
      'latest request',
      'latest answer',
    ]);
  });

  it('selects the active Claude branch through thinking-only records', () => {
    const path = fixture([
      { type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'request' } },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: { content: [{ type: 'text', text: 'discarded answer' }] },
      },
      {
        type: 'assistant',
        uuid: 'think',
        parentUuid: 'u1',
        message: { content: [{ type: 'thinking', thinking: 'private' }] },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'think',
        message: { content: [{ type: 'text', text: 'current answer' }] },
      },
    ]);
    expect(readNativeMigrationMessages('claude', path).map((message) => message.text)).toEqual([
      'request',
      'current answer',
    ]);
  });

  it('keeps the effective context after Claude compaction, not the old overflow', () => {
    const path = fixture([
      { type: 'user', message: { content: 'old context' } },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'user', isCompactSummary: true, message: { content: 'effective summary' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'recent reply' }] } },
    ]);
    expect(readNativeMigrationMessages('claude', path).map((message) => message.text)).toEqual([
      'effective summary',
      'recent reply',
    ]);
  });

  it('does not truncate long tool evidence into the stream display limit', () => {
    const output = 'result'.repeat(4000);
    const path = fixture([
      { type: 'user', message: { content: 'request' } },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo result' } }],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call1', content: output }] },
      },
    ]);
    const messages = readNativeMigrationMessages('claude', path);
    expect(messages[1]?.text).toContain('[Historical tool call: Bash]');
    expect(messages[2]?.text).toContain(output);
    expect(messages[2]?.text.length).toBeGreaterThan(8000);
  });

  it('uses Codex model history and replacement history, not duplicate UI events', () => {
    const path = fixture([
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old' }] },
      },
      {
        type: 'compacted',
        payload: {
          replacement_history: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summary' }] },
          ],
        },
      },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'current' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'current' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'source-only rules' }],
        },
      },
    ]);
    expect(readNativeMigrationMessages('codex', path).map((message) => message.text)).toEqual([
      'summary',
      'current',
    ]);
  });

  it('refuses a Codex compaction that cannot be reconstructed', () => {
    expect(() =>
      readNativeMigrationMessages(
        'codex',
        fixture([{ type: 'compacted', payload: { message: 'summary without replacement' } }]),
      ),
    ).toThrow('replacement history');
  });

  it('streams multibyte records across read boundaries without changing text', () => {
    const body = '中文上下文'.repeat(90_000);
    const path = fixture([{ type: 'user', message: { content: body } }]);
    expect(readNativeMigrationMessages('claude', path)[0]?.text).toBe(body);
  });
});
