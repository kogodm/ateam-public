import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ateamHome } from './paths';

/**
 * The shared "last open session set", persisted at `~/.ateam/tui-state.json`.
 * Owned by the core so the TUI and the desktop GUI restore the SAME state:
 * close the TUI with sessions open, launch the app → it offers to reopen
 * them (and vice-versa). One cache, one format, two front-ends.
 */
import type { ProviderId } from '@ateam/contract';

export interface SavedAgent {
  projectName: string;
  agentName: string;
  role: string;
  dir: string;
  claudeSessionId: string;
  /** directory-less ("talk to a human") session — no workspace on restore */
  directoryless?: boolean;
  /** agent CLI that drove the session (absent = claude) */
  providerId?: ProviderId;
}

interface FileShape {
  agents?: SavedAgent[];
  /** the session that was focused at last save — the desktop GUI spawns
   *  this one FIRST on restore so the user can start working immediately
   *  while the rest are still booting in parallel. */
  focusedClaudeSessionId?: string;
}

export function sessionStatePath(): string {
  return join(ateamHome(), 'tui-state.json');
}

function readFile(): FileShape | undefined {
  try {
    return JSON.parse(readFileSync(sessionStatePath(), 'utf8')) as FileShape;
  } catch {
    return undefined;
  }
}

export function loadSessionState(): SavedAgent[] {
  return readFile()?.agents ?? [];
}

export function loadFocusedClaudeSessionId(): string | undefined {
  return readFile()?.focusedClaudeSessionId;
}

/** Best-effort write. The caller decides whether to skip empty sets — both
 *  front-ends avoid clobbering a good set with an empty one. When the caller
 *  doesn't pass `focusedClaudeSessionId` (e.g. the TUI, which doesn't track
 *  it yet), the previous focused value is preserved instead of being lost.
 *
 *  Atomic (temp file + rename): this fires on every tree change, so a crash
 *  (OS-level, not just the app) mid-write is a real scenario, not a
 *  theoretical one — a torn `writeFileSync` would leave invalid JSON, and
 *  `readFile()`'s parse-failure fallback silently returns "no saved
 *  agents", losing the ENTIRE restore set instead of just the latest
 *  change. `rename` on the same filesystem is atomic, so readers only ever
 *  see the old complete file or the new complete file, never a partial one. */
export function saveSessionState(
  agents: SavedAgent[],
  focusedClaudeSessionId?: string,
): void {
  try {
    const dir = ateamHome();
    mkdirSync(dir, { recursive: true });
    const existing = focusedClaudeSessionId === undefined ? readFile() : undefined;
    const payload: FileShape = {
      agents,
      focusedClaudeSessionId:
        focusedClaudeSessionId !== undefined
          ? focusedClaudeSessionId
          : existing?.focusedClaudeSessionId,
    };
    const file = sessionStatePath();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, file);
  } catch {
    /* persistence is best-effort */
  }
}
