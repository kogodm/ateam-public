import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ateamHome } from '../paths';

/**
 * Persistent meta for auto-handoff so:
 *   1. Successful takeovers delete the temp handoff doc (don't litter $TMPDIR).
 *   2. Re-triggering handoff for a session whose doc was already written but
 *      whose successor never spawned (regex miss, sidecar crash, etc.) skips
 *      the prompt injection and jumps straight to spawnSuccessor.
 *   3. The whole pipeline is auditable across process restarts.
 *
 * Stored at `~/.ateam/handoff-state.json`. Keyed by the OLD session's
 * claudeSessionId because it's the only id stable across runs.
 *
 * Status flow:
 *   pending     → prompt injected, waiting for claude's marker line
 *   doc_ready   → marker line seen, file exists on disk, successor not yet spawned
 *   taken_over  → successor spawned; temp file deleted; record kept for history
 *   failed      → 90s timeout elapsed without marker (sticky for user inspection)
 */
export type HandoffStatus = 'pending' | 'doc_ready' | 'taken_over' | 'failed';

export interface HandoffRecord {
  /** Old session's stable id (the resume id). */
  oldClaudeSessionId: string;
  /** Old session's transient in-memory id at the time of trigger.
   *  Useful for UI correlation if the sidecar hasn't restarted. */
  oldSessionId?: string;
  handoffPath: string;
  status: HandoffStatus;
  triggeredAt: string;
  /** Set when status flips to doc_ready. */
  docReadyAt?: string;
  /** Set when status flips to taken_over. */
  takenOverAt?: string;
  successorClaudeSessionId?: string;
  successorSessionId?: string;
}

interface FileShape {
  records: Record<string, HandoffRecord>;
}

function statePath(): string {
  return join(ateamHome(), 'handoff-state.json');
}

function load(): FileShape {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as FileShape;
  } catch {
    return { records: {} };
  }
}

function save(s: FileShape): void {
  mkdirSync(ateamHome(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(s, null, 2));
}

export function getHandoffRecord(oldClaudeSessionId: string): HandoffRecord | undefined {
  return load().records[oldClaudeSessionId];
}

/** Insert / replace a record for this old session. */
export function upsertHandoffRecord(rec: HandoffRecord): void {
  const s = load();
  s.records[rec.oldClaudeSessionId] = rec;
  save(s);
}

/** Patch a record's status + per-status timestamp. No-op if record missing. */
export function patchHandoffStatus(
  oldClaudeSessionId: string,
  patch: Partial<Omit<HandoffRecord, 'oldClaudeSessionId'>>,
): void {
  const s = load();
  const cur = s.records[oldClaudeSessionId];
  if (!cur) return;
  s.records[oldClaudeSessionId] = { ...cur, ...patch };
  save(s);
}

/** Mark a handoff as taken-over by a successor session AND delete the temp
 *  handoff file. Errors are swallowed (file may have been cleaned by another
 *  run / by tmp eviction; the record is what matters). */
export function finalizeTakeover(
  oldClaudeSessionId: string,
  successor: { sessionId: string; claudeSessionId: string },
): void {
  const s = load();
  const cur = s.records[oldClaudeSessionId];
  if (!cur) return;
  // Crash-safety: do NOT delete the handoff doc here. The successor writes
  // its transcript lazily (on its first completed turn); if the process is
  // killed between this point and that first turn, deleting the doc now
  // would leave the handoff unrecoverable (successor empty, doc gone). We
  // keep the doc until the successor PROVES it took over (its transcript
  // exists) — see cleanupTakenOverDoc, called from the next spawn.
  s.records[oldClaudeSessionId] = {
    ...cur,
    status: 'taken_over',
    takenOverAt: new Date().toISOString(),
    successorSessionId: successor.sessionId,
    successorClaudeSessionId: successor.claudeSessionId,
  };
  save(s);
}

/** Look up a handoff record by its successor's claudeSessionId. Used at
 *  spawn time to detect an interrupted handoff that should be continued
 *  (successor was spawned but never finished its first turn before the
 *  process died, so it has no transcript and the doc is still on disk). */
export function getHandoffBySuccessor(
  successorClaudeSessionId: string,
): HandoffRecord | undefined {
  const s = load();
  for (const rec of Object.values(s.records)) {
    if (rec.successorClaudeSessionId === successorClaudeSessionId) return rec;
  }
  return undefined;
}

/** Delete the handoff doc once the successor is confirmed to have taken
 *  over (its transcript exists). Idempotent; safe to call repeatedly. */
export function cleanupTakenOverDoc(oldClaudeSessionId: string): void {
  const s = load();
  const cur = s.records[oldClaudeSessionId];
  if (!cur?.handoffPath) return;
  try {
    if (existsSync(cur.handoffPath)) rmSync(cur.handoffPath, { force: true });
  } catch {
    /* ignore */
  }
}

/** True if a record is still "actionable" — claude wrote the doc, the file
 *  still exists, and the record is fresh enough to be relevant (default 30
 *  minutes). Lets handoffNow short-circuit by reusing a doc that was
 *  written but never made it through spawnSuccessor (regex miss, crash,
 *  network blip on the WS, etc.). */
export function isReusableDoc(
  rec: HandoffRecord | undefined,
  maxAgeMs = 30 * 60 * 1000,
): boolean {
  if (!rec) return false;
  if (rec.status !== 'doc_ready') return false;
  if (!rec.handoffPath || !existsSync(rec.handoffPath)) return false;
  try {
    const age = Date.now() - statSync(rec.handoffPath).mtimeMs;
    return age < maxAgeMs;
  } catch {
    return false;
  }
}

/** True when this claude session was handed off to a successor that took
 *  over. Such a session must never be restored as its own row again — the
 *  successor IS the conversation now. */
export function isHandedOff(oldClaudeSessionId: string): boolean {
  return load().records[oldClaudeSessionId]?.status === 'taken_over';
}
