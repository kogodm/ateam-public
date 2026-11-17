import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId, Turn } from '@ateam/contract';
import type { NativeMigrationResult } from './native-migration-types';
import { codexHome } from './providers/codex-sessions';
import { renameCursorImportedSession } from './providers/cursor-session-import';

export function preserveImportedSessionName(
  providerId: ProviderId,
  imported: NativeMigrationResult,
  sessionName: string,
): void {
  if (!sessionName.trim()) return;
  if (providerId === 'codex') {
    appendFileSync(
      join(codexHome(), 'session_index.jsonl'),
      `${JSON.stringify({ id: imported.sessionId, thread_name: sessionName, updated_at: new Date().toISOString() })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } else if (providerId === 'claude') {
    appendFileSync(
      imported.path,
      `${JSON.stringify({ type: 'custom-title', customTitle: sessionName, sessionId: imported.sessionId })}\n`,
      'utf8',
    );
  } else if (providerId === 'cursor') {
    renameCursorImportedSession(imported.path, sessionName);
  }
}

export interface ContinuationSource {
  providerId: ProviderId;
  model?: string;
  cwd: string;
  sessionName: string;
  rawTranscriptPath?: string;
}

/** Provider-neutral transcript artifact. The old model is deliberately not
 * involved: Ateam reads its local store and the NEW model interprets this. */
export function continuationBundleText(source: ContinuationSource, turns: readonly Turn[]): string {
  const visible = turns.filter((t) => t.kind !== 'thinking');
  const out = [
    '# Ateam continuation context',
    '',
    'Generated locally so another provider can continue this session without asking the old model to summarize it.',
    '',
    `- Source runtime: ${source.providerId}`,
    `- Source model: ${source.model || '(unknown)'}`,
    `- Session: ${source.sessionName}`,
    `- Workspace: ${source.cwd}`,
    `- Raw provider transcript: ${source.rawTranscriptPath || '(not available)'}`,
    '',
    '## Latest normalized transcript',
    '',
    'The workspace is shared with the new session. Treat completed tool calls and file edits below as already done; inspect the current files and git state before repeating work.',
  ];
  for (const turn of visible) {
    const tool = turn.toolName ? ` · ${turn.toolName}` : '';
    out.push('', `### ${turn.role}${tool}`, '', turn.text.trim());
  }
  if (visible.length === 0)
    out.push('', '(No structured transcript was available; inspect the workspace state.)');
  return `${out.join('\n').trim()}\n`;
}

export function writeContinuationBundle(
  source: ContinuationSource,
  turns: readonly Turn[],
  dir = tmpdir(),
): string {
  const path = join(dir, `ateam-provider-switch-${randomUUID()}.md`);
  writeFileSync(path, continuationBundleText(source, turns), { encoding: 'utf8', mode: 0o600 });
  return path;
}

export function continuationPrompt(path: string, from: ProviderId, to: ProviderId): string {
  return [
    `[Ateam provider switch: ${from} -> ${to}]`,
    `The previous runtime may be out of quota and cannot prepare a handoff. Ateam exported its local context to: ${path}`,
    'Read that file now. It contains the latest normalized conversation and the path to the original provider transcript for older details if needed.',
    'Then inspect the current workspace and git state, continue from the exact point already reached, and do not ask the user to restate the task or repeat completed work.',
  ].join('\n');
}
