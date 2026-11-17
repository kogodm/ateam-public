import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ateamHome } from '../paths';

/**
 * Durable `claudeSessionId -> humanId` index, stored at
 * `~/.ateam/claude-session-owners.json`. Claude Code transcripts carry no
 * concept of "human" — this is the only record of which Ateam human ran a
 * given claude session, so the Resume modal (and anything else keyed off a
 * raw `~/.claude/projects/<slug>/*.jsonl` id) can show the right avatar and
 * resume as the same human instead of asking again.
 *
 * Written at every `manager.spawn()` (fresh or resume) and every `/clear`
 * rotation (`linkClaudeSession`), so it stays current for sessions Ateam
 * actually ran. Sessions spawned outside Ateam, or from before this index
 * existed, simply have no entry — callers must treat a miss as "unknown",
 * not as an error.
 */
interface FileShape {
  owners: Record<string, string>;
}

function ownersPath(): string {
  return join(ateamHome(), 'claude-session-owners.json');
}

function load(): FileShape {
  try {
    return JSON.parse(readFileSync(ownersPath(), 'utf8')) as FileShape;
  } catch {
    return { owners: {} };
  }
}

/** Best-effort write — losing this index degrades to "no avatar shown", not
 *  a functional break, so a write failure is swallowed rather than thrown. */
export function recordSessionOwner(claudeSessionId: string, humanId: string): void {
  if (!claudeSessionId || !humanId) return;
  try {
    const s = load();
    if (s.owners[claudeSessionId] === humanId) return; // no-op write avoided
    s.owners[claudeSessionId] = humanId;
    mkdirSync(ateamHome(), { recursive: true });
    writeFileSync(ownersPath(), JSON.stringify(s, null, 2));
  } catch {
    /* best-effort */
  }
}

export function getSessionOwner(claudeSessionId: string): string | undefined {
  return load().owners[claudeSessionId];
}

/** Batch lookup for a list of ids (one file read instead of N). */
export function getSessionOwners(claudeSessionIds: readonly string[]): Record<string, string> {
  const all = load().owners;
  const out: Record<string, string> = {};
  for (const id of claudeSessionIds) {
    const h = all[id];
    if (h) out[id] = h;
  }
  return out;
}
