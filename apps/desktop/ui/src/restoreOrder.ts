import type { SessionStateAgent } from '@ateam/contract';

/**
 * Order saved sessions for a "Restore all" load.
 *
 * Ordering: the priority (last-focused) session FIRST, then the rest by
 * last-used time descending.
 *
 * NOTE on "last-used time descending": SessionStateAgent has no timestamp
 * field today, so we use the saved-array order as the best available proxy
 * for recency (the GUI persists `[...live, ...remembered]`, and the live
 * tree roughly tracks recency). A precise sort would require adding an
 * optional `lastUsedAt?: string` to SessionStateAgent (domain.ts), the
 * sessionState.set zod schema, and having buildAgents write `s.mtime` —
 * deliberately deferred to avoid a cross-package contract change here.
 *
 * Pure / side-effect free so the gray-placeholder render and the spawn
 * loop share ONE ordering and it can be unit-tested.
 */
export function orderForRestore(
  saved: SessionStateAgent[],
  focusClaudeSessionId?: string,
): SessionStateAgent[] {
  const priority =
    saved.find((a) => a.claudeSessionId === focusClaudeSessionId) ?? saved[0];
  if (!priority) return [];
  const rest = saved.filter((a) => a !== priority);
  return [priority, ...rest];
}
