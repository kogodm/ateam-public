import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Which conversations the claude CLI currently has open, and how.
 *
 * Claude Code 2.1 added background agents (`claude --bg`, `claude agents`), and
 * with them a rule: a session that is already running as a background agent
 * REFUSES to be resumed —
 *
 *   Session <id> is currently running as a background agent (bg). Use
 *   `claude agents` to find and attach to it, or add --fork-session to
 *   branch off a copy.
 *
 * — and exits 1. Ateam resumes on restore and on wake, so such a session used
 * to come back as a dead exit-1 tombstone with the reason buried in a terminal
 * nobody reads.
 *
 * The CLI can report this (`claude agents --json`), but that call costs ~1.8s —
 * far too slow to sit in front of every resume. It reads the same registry we
 * read here: one small JSON per live process under `~/.claude/sessions/`.
 * Parsing all of them takes ~30ms, which is cheap enough to check before every
 * resume, so the decision can be made BEFORE the PTY starts instead of being
 * recovered from a failure afterwards.
 */

export type ClaudeSessionKind = 'bg' | 'interactive' | string;

/** how long a scan is reused — a restore boots sessions in a tight loop */
const CACHE_MS = 2_000;
/** defensive cap: this directory accumulates one file per process ever seen */
const MAX_FILES = 2_000;

let cache: { at: number; live: Map<string, ClaudeSessionKind> } | undefined;

function sessionsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions');
}

/** Is this pid still around? The registry keeps files for processes that died
 *  without cleaning up, and a stale entry would fork a session for no reason. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, sends nothing
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else — still alive
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** claudeSessionId → kind, for every claude process running right now. */
export function liveClaudeSessions(): Map<string, ClaudeSessionKind> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.live;
  const live = new Map<string, ClaudeSessionKind>();
  const dir = sessionsDir();
  try {
    if (existsSync(dir)) {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .slice(0, MAX_FILES);
      for (const f of files) {
        try {
          const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
            sessionId?: string;
            pid?: number;
            kind?: string;
          };
          if (!r.sessionId || !r.pid || !alive(r.pid)) continue;
          live.set(r.sessionId, r.kind ?? 'interactive');
        } catch {
          /* half-written or a format we don't know — ignore this one */
        }
      }
    }
  } catch {
    /* no registry (older CLI, different home) — nothing is known to be live */
  }
  cache = { at: Date.now(), live };
  return live;
}

/**
 * Would `claude --resume <id>` be refused because the conversation is already
 * open as a background agent? Only 'bg' refuses; an interactive session
 * elsewhere is left alone, since the CLI still resumes those.
 */
export function isRunningAsBackgroundAgent(claudeSessionId: string): boolean {
  if (!claudeSessionId) return false;
  return liveClaudeSessions().get(claudeSessionId) === 'bg';
}

/** test seam — the registry is read at most every CACHE_MS otherwise */
export function clearLiveSessionCache(): void {
  cache = undefined;
}
