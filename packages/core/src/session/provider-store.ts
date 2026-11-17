import type { ProviderId } from '@ateam/contract';
import {
  codexCreatedAt,
  codexLastActiveAt,
  codexModel,
  codexRolloutPath,
  codexThreadName,
} from './providers/codex-sessions';
import {
  cursorChatStorePath,
  cursorChatTitle,
  cursorCreatedAt,
  cursorLastActiveAt,
} from './providers/cursor-sessions';
import {
  claudeCreatedAt,
  claudeLastActiveAt,
  claudeModel,
  claudeSummary,
  transcriptPath,
} from './transcript-file';

/**
 * Provider-neutral reads of "the CLI's own record of this conversation" —
 * where the transcript lives, what the user named it, when it started /
 * last moved. claude → ~/.claude/projects transcript; codex → ~/.codex
 * rollout + session_index. opencode has no wired store yet → empty.
 */
export function storeTranscriptPath(providerId: ProviderId, cwd: string, id: string): string {
  if (providerId === 'codex') return codexRolloutPath(id);
  if (providerId === 'claude') return transcriptPath(cwd, id);
  return '';
}

/** Path used to resume a conversation. Cursor's store is SQLite (`store.db`),
 * not JSONL; JSONL readers must not open it. The stream view reads that file
 * through the checkpoint projection (`readCursorStreamPage`). */
export function storeResumePath(providerId: ProviderId, cwd: string, id: string): string {
  if (providerId === 'cursor') return cursorChatStorePath(cwd, id);
  return storeTranscriptPath(providerId, cwd, id);
}

export function storeTitle(providerId: ProviderId, cwd: string, id: string): string {
  if (providerId === 'codex') return codexThreadName(id);
  if (providerId === 'claude') return claudeSummary(cwd, id);
  if (providerId === 'cursor') return cursorChatTitle(cwd, id);
  return '';
}

export function storeCreatedAt(providerId: ProviderId, cwd: string, id: string): string {
  if (providerId === 'codex') return codexCreatedAt(id);
  if (providerId === 'claude') return claudeCreatedAt(cwd, id);
  if (providerId === 'cursor') return cursorCreatedAt(cwd, id);
  return '';
}

export function storeLastActiveAt(providerId: ProviderId, cwd: string, id: string): string {
  if (providerId === 'codex') return codexLastActiveAt(id);
  if (providerId === 'claude') return claudeLastActiveAt(cwd, id);
  if (providerId === 'cursor') return cursorLastActiveAt(cwd, id);
  return '';
}

/** Which model the conversation is actually using right now. Both runtimes
 *  record it as they go — claude on every assistant message, codex in its
 *  turn_context — so this never has to ask the CLI or touch the PTY. */
export function storeModel(providerId: ProviderId, cwd: string, id: string): string {
  if (providerId === 'codex') return codexModel(id);
  if (providerId === 'claude') return claudeModel(cwd, id);
  return '';
}
