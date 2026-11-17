import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NativeMigrationMessage, NativeMigrationResult } from '../native-migration-types';

export function writeCodexSessionImport(
  messages: readonly NativeMigrationMessage[],
  cwd: string,
  home = process.env.CODEX_HOME || join(homedir(), '.codex'),
): NativeMigrationResult {
  if (!messages.some((message) => message.role === 'user' && message.text.trim()))
    throw new Error('Cannot migrate a session without user history');
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const path = join(
    home,
    'sessions',
    ...now.slice(0, 10).split('-'),
    // Paginated resume requires a timestamp with second precision, without a
    // fractional part or timezone suffix (legacy resume accepted both).
    `rollout-${now.slice(0, 19).replace(/:/g, '-')}-${sessionId}.jsonl`,
  );
  const records: unknown[] = [
    {
      timestamp: now,
      type: 'session_meta',
      payload: {
        id: sessionId,
        session_id: sessionId,
        timestamp: now,
        cwd,
        originator: 'ateam',
        cli_version: '0.0.0',
        source: 'cli',
        model_provider: 'openai',
      },
    },
  ];
  let turnId = '';
  for (const message of messages) {
    if (!message.text.trim()) continue;
    const timestamp = Number.isNaN(Date.parse(message.at)) ? now : message.at;
    if (message.role === 'user') {
      if (turnId)
        records.push({
          timestamp,
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: turnId,
            last_agent_message: null,
          },
        });
      turnId = randomUUID();
      records.push({
        timestamp,
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: turnId,
          model_context_window: null,
        },
      });
    }
    if (!turnId) continue;
    records.push({
      timestamp,
      type: 'event_msg',
      payload: {
        type: message.role === 'user' ? 'user_message' : 'agent_message',
        message: message.text,
        ...(message.role === 'user' ? { images: [], local_images: [], text_elements: [] } : {}),
      },
    });
    records.push({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: message.role,
        content: [
          { type: message.role === 'user' ? 'input_text' : 'output_text', text: message.text },
        ],
      },
    });
  }
  records.push({
    timestamp: now,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: null,
    },
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return { sessionId, path };
}
