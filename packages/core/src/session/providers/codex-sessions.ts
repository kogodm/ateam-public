import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeSessionInfo } from '@ateam/contract';
import { getSessionOwners } from '../session-owners';
import { readChunk } from '../transcript-file';

/**
 * Codex CLI's on-disk session store (verified against codex-cli 0.147):
 *   • rollouts: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`
 *     (local-date dirs; Codex 0.166 also keeps the same name with `.jsonl.zst`).
 *     Written LAZILY on the first turn; line 0 is a
 *     `session_meta` record carrying the thread id, cwd and the process
 *     START timestamp (= the ts in the file name).
 *   • names: `$CODEX_HOME/session_index.jsonl`, appended on every `/rename`
 *     — `{id, thread_name, updated_at}`; the LAST line per id wins.
 *   • `codex resume <threadId>` re-opens a rollout interactively.
 *
 * Codex assigns thread ids itself (no --session-id at spawn), so
 * SessionManager discovers the id after the fact via `discoverCodexThread`
 * and re-keys the session to it — from then on rename/resume/last-active all
 * read from here the way the claude paths read the claude transcript.
 */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

interface RolloutMeta {
  readonly id: string;
  readonly cwd: string;
  /** ms epoch of the codex process start */
  readonly startedAt: number;
}

const ROLLOUT_RE = /^rollout-.*-([0-9a-f-]{36})\.jsonl(?:\.zst)?$/i;

function dayDir(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return join(
    codexHome(),
    'sessions',
    String(d.getFullYear()),
    p(d.getMonth() + 1),
    p(d.getDate()),
  );
}

/** Child directories only. A stray file such as `.DS_Store` must not abort
 *  the scan: one `readdir` throw used to discard every rollout older than
 *  yesterday, and restore then started a blank `codex` instead of `resume`. */
function childDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

/** rollout files (newest dirs first) — today + yesterday only unless `all` */
function rolloutFiles(all = false): string[] {
  const root = join(codexHome(), 'sessions');
  const dirs: string[] = [];
  if (all) {
    for (const year of childDirs(root))
      for (const month of childDirs(year)) dirs.push(...childDirs(month));
    dirs.sort().reverse();
  } else {
    const now = new Date();
    dirs.push(dayDir(now), dayDir(new Date(now.getTime() - 86_400_000)));
  }
  const files: string[] = [];
  for (const dir of dirs) {
    try {
      for (const f of readdirSync(dir)) if (ROLLOUT_RE.test(f)) files.push(join(dir, f));
    } catch {
      /* day dir absent */
    }
  }
  return files;
}

const pathCache = new Map<string, string>();

/** absolute rollout path for a thread id, '' if codex has not written one
 *  (yet). Positive hits are cached — rollouts never move. */
function pickRollout(files: readonly string[], threadId: string): string | undefined {
  const plain = `-${threadId}.jsonl`;
  const compressed = `-${threadId}.jsonl.zst`;
  return files.find((f) => f.endsWith(plain)) ?? files.find((f) => f.endsWith(compressed));
}

export function codexRolloutPath(threadId: string): string {
  const hit = pathCache.get(threadId);
  if (hit && existsSync(hit)) return hit;
  const found = pickRollout(rolloutFiles(), threadId) ?? pickRollout(rolloutFiles(true), threadId);
  if (found) pathCache.set(threadId, found);
  return found ?? '';
}

/** Newest rollout on disk by mtime — used when no Codex session is focused
 *  but we still want ChatGPT's account-wide rate_limits for the Status panel.
 *  Prefers plain `.jsonl` (readable); skips `.zst` the sidecar cannot decompress. */
export function newestCodexRolloutPath(): string {
  let best = '';
  let bestM = 0;
  for (const full of rolloutFiles(true)) {
    if (full.endsWith('.zst')) continue;
    try {
      const m = statSync(full).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = full;
      }
    } catch {
      /* gone between readdir and stat */
    }
  }
  return best;
}

function readMeta(path: string): RolloutMeta | undefined {
  const [line] = readChunk(path, 64 * 1024, false);
  if (!line) return undefined;
  try {
    const o = JSON.parse(line) as {
      type?: string;
      payload?: { id?: string; cwd?: string; timestamp?: string };
    };
    if (o.type !== 'session_meta' || !o.payload?.id || !o.payload.cwd) return undefined;
    const startedAt = Date.parse(o.payload.timestamp ?? '');
    return {
      id: o.payload.id,
      cwd: o.payload.cwd,
      startedAt: Number.isNaN(startedAt) ? 0 : startedAt,
    };
  } catch {
    return undefined;
  }
}

/** Find the thread id of a codex process we spawned at `spawnedAtMs` in
 *  `cwd`: the unclaimed rollout in that cwd whose start timestamp is
 *  closest to (and within `toleranceMs` of) our spawn time. Undefined
 *  until codex writes the rollout (first turn). */
export function discoverCodexThread(
  cwd: string,
  spawnedAtMs: number,
  isClaimed: (threadId: string) => boolean,
  toleranceMs = 60_000,
): string | undefined {
  let best: { id: string; delta: number } | undefined;
  for (const f of rolloutFiles()) {
    let mtime = 0;
    try {
      mtime = statSync(f).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < spawnedAtMs - toleranceMs) continue; // predates us — skip the parse
    const m = readMeta(f);
    if (!m || m.cwd !== cwd || isClaimed(m.id)) continue;
    const delta = Math.abs(m.startedAt - spawnedAtMs);
    if (delta > toleranceMs) continue;
    if (!best || delta < best.delta) best = { id: m.id, delta };
  }
  return best?.id;
}

/** the user's `/rename` label for a thread ('' if never renamed). */
/** The latest model from this thread's settings events or turn contexts.
 *  Settings events reflect /model changes before another turn starts. */
export function codexModel(threadId: string): string {
  const path = codexRolloutPath(threadId);
  if (!path || !existsSync(path)) return '';
  const tail = readChunk(path, 256 * 1024, true);
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!line?.includes('turn_context') && !line?.includes('thread_settings_applied')) continue;
    try {
      const o = JSON.parse(line) as {
        type?: string;
        payload?: {
          type?: string;
          model?: unknown;
          thread_id?: string;
          thread_settings?: { model?: unknown };
        };
      };
      const model =
        o.type === 'turn_context'
          ? o.payload?.model
          : o.type === 'event_msg' &&
              o.payload?.type === 'thread_settings_applied' &&
              o.payload.thread_id === threadId
            ? o.payload.thread_settings?.model
            : undefined;
      if (typeof model === 'string' && model.trim()) return model;
    } catch {
      /* partial line at the chunk boundary */
    }
  }
  return '';
}

export function codexThreadName(threadId: string): string {
  const idx = join(codexHome(), 'session_index.jsonl');
  if (!existsSync(idx)) return '';
  // newest entries are at the tail; scan backwards for the first match
  const lines = readChunk(idx, 256 * 1024, true);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes(threadId)) continue;
    try {
      const o = JSON.parse(line) as { id?: string; thread_name?: string };
      if (o.id === threadId && o.thread_name) return o.thread_name;
    } catch {
      /* partial line */
    }
  }
  return '';
}

/** ISO start time of the thread's rollout ('' if not written yet). */
export function codexCreatedAt(threadId: string): string {
  const p = codexRolloutPath(threadId);
  if (!p) return '';
  const m = readMeta(p);
  return m?.startedAt ? new Date(m.startedAt).toISOString() : '';
}

/** ISO timestamp of the newest record in the thread's rollout. */
export function codexLastActiveAt(threadId: string): string {
  const p = codexRolloutPath(threadId);
  if (!p) return '';
  // Compressed rollouts are still the session. mtime is enough for hibernate;
  // the sidecar's Node cannot decompress them.
  if (p.endsWith('.zst')) {
    try {
      return new Date(statSync(p).mtimeMs).toISOString();
    } catch {
      return '';
    }
  }
  const lines = readChunk(p, 64 * 1024, true);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i] ?? '') as { timestamp?: string };
      if (o.timestamp) return o.timestamp;
    } catch {
      /* partial line */
    }
  }
  return '';
}

/** first real user message of a rollout (the environment_context preamble
 *  codex injects is skipped), '' if none in the head window. */
function codexFirstUserText(path: string): string {
  for (const line of readChunk(path, 128 * 1024, false).slice(0, 60)) {
    try {
      const o = JSON.parse(line) as {
        type?: string;
        payload?: { type?: string; role?: string; content?: Array<{ text?: string }> };
      };
      if (o.type !== 'response_item' || o.payload?.type !== 'message') continue;
      if (o.payload.role !== 'user') continue;
      const text = (o.payload.content ?? [])
        .map((c) => c.text ?? '')
        .join(' ')
        .trim();
      if (!text || text.startsWith('<environment_context>')) continue;
      return text.replace(/\s+/g, ' ').slice(0, 80);
    } catch {
      /* partial line */
    }
  }
  return '';
}

/** Codex threads started in `cwd`, newest first — the Resume dialog's
 *  codex half. Only the newest `scan` rollouts (by mtime) are opened; each
 *  costs one head read for its session_meta. */
export function listCodexThreads(cwd: string, limit = 30, scan = 200): ClaudeSessionInfo[] {
  const rows = rolloutFiles(true)
    .map((full) => {
      try {
        return { full, mtimeMs: statSync(full).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((r): r is { full: string; mtimeMs: number } => Boolean(r))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, scan);
  const out: Array<Omit<ClaudeSessionInfo, 'humanId'>> = [];
  for (const { full, mtimeMs } of rows) {
    if (out.length >= limit) break;
    const m = readMeta(full);
    if (!m || m.cwd !== cwd) continue;
    pathCache.set(m.id, full);
    out.push({
      id: m.id,
      mtime: new Date(mtimeMs).toISOString(),
      title: codexThreadName(m.id),
      summary: codexFirstUserText(full) || '(no summary)',
      providerId: 'codex',
    });
  }
  const owners = getSessionOwners(out.map((r) => r.id));
  return out.map((r) => {
    const humanId = owners[r.id];
    return humanId ? { ...r, humanId } : r;
  });
}
