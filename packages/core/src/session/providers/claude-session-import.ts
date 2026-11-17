import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { claudeProjectDir } from '../claude-sessions';
import type { NativeMigrationMessage, NativeMigrationResult } from '../native-migration-types';

export function writeClaudeSessionImport(
  messages: readonly NativeMigrationMessage[],
  cwd: string,
  projectDir = claudeProjectDir(cwd),
): NativeMigrationResult {
  if (!isAbsolute(cwd)) throw new Error('Claude import requires an absolute cwd');
  if (!isAbsolute(projectDir))
    throw new Error('Claude import requires an absolute project directory');
  const sessionId = randomUUID();
  let parentUuid: string | null = null;
  let hasUser = false;
  const records: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new Error('Claude import only accepts user and assistant messages');
    }
    if (typeof message.text !== 'string' || !Number.isFinite(Date.parse(message.at))) {
      throw new Error('Claude import requires text and a valid timestamp');
    }
    if (!message.text.trim()) continue;
    if (message.role === 'user') hasUser = true;
    const uuid = randomUUID();
    records.push(
      JSON.stringify({
        type: message.role,
        uuid,
        parentUuid,
        sessionId,
        timestamp: message.at,
        cwd,
        isSidechain: false,
        userType: 'external',
        message:
          message.role === 'user'
            ? { role: 'user', content: message.text }
            : {
                id: `msg_${randomUUID().replace(/-/g, '')}`,
                type: 'message',
                role: 'assistant',
                model: '<synthetic>',
                content: [{ type: 'text', text: message.text }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
      }),
    );
    parentUuid = uuid;
  }
  if (records.length === 0)
    throw new Error('Claude import requires non-empty conversation history');
  if (!hasUser) throw new Error('Cannot migrate a session without user history');
  const path = join(projectDir, `${sessionId}.jsonl`);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${records.join('\n')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { sessionId, path };
}
