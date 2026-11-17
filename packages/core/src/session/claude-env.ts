import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * Markers a running `claude` exports into everything it spawns.
 *
 * Ateam's own sessions are top-level by definition, but the app can be started
 * from inside a claude session (the in-chat restart flow runs from a claude
 * PTY, and `open` hands the caller's environment to the app), and then every
 * marker travels app → sidecar → each new claude PTY. The visible damage is
 * one yellow line — "Transcript saving is off — inherited
 * CLAUDE_CODE_CHILD_SESSION marker" — but the transcript IS the app: without
 * it the turn watcher, token estimate, path index, /clear tracking, the
 * handoff chain, session.locate and resume all go quiet at once, with no error
 * anywhere (2026-08-25: ~40 minutes of every session's conversation unsaved).
 *
 * An explicit list, not a `CLAUDE_*` sweep: `CLAUDE_CONFIG_DIR`,
 * `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` and the `ANTHROPIC_*` credentials share
 * the prefix and MUST reach the PTY.
 */
export const CLAUDE_PROCESS_MARKERS = [
  /** "you are running under claude" — the flag adapters key off */
  'CLAUDECODE',
  /** the one that silently turns transcript saving off */
  'CLAUDE_CODE_CHILD_SESSION',
  /** the PARENT's session id — a new session inheriting it claims another
   *  session's identity */
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  /** the parent's pid */
  'CLAUDE_PID',
  /** IPC back to the PARENT process — a child pointed at these is talking on
   *  someone else's socket with someone else's credential */
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  /** generic "an agent is driving this shell" flag some tools branch on */
  'AI_AGENT',
] as const;

/** Which markers this environment is carrying (empty when clean). */
export function inheritedClaudeMarkers(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return CLAUDE_PROCESS_MARKERS.filter((k) => env[k] !== undefined && env[k] !== '');
}

/**
 * A copy of `env` with every marker removed.
 *
 * Strip the FINAL merged environment, never just `process.env`: the login
 * shell we harvest is itself a child of this process, so `zsh -lc env` prints
 * the markers straight back, and a spread of a sanitised `process.env` cannot
 * remove a key the login-shell spread already put there — a deleted key is
 * simply absent, not an override. That is exactly how the leak survived being
 * "fixed" once.
 */
export function stripClaudeProcessMarkers<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const k of CLAUDE_PROCESS_MARKERS) delete out[k];
  return out;
}

/**
 * The `env` block of the user's `~/.claude/settings.json`. The interactive
 * CLI applies it itself, which is how a PTY session gets its proxy / API
 * endpoint even when the app was launched from Finder with a bare
 * environment. A headless `claude -p` run with `--setting-sources ""` (to
 * keep its prompt small) does NOT, so a caller that skips settings must
 * merge this in by hand — without it the request goes out direct and is
 * refused (seen: "403 Request not allowed" behind a proxy-only network).
 */
export function claudeSettingsEnv(): Record<string, string> {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8');
    const env = (JSON.parse(raw) as { env?: Record<string, unknown> }).env;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env ?? {})) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}
