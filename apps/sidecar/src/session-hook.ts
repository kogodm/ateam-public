/**
 * Claude Code `SessionStart` hook reporter. ATeam injects this via `--settings`
 * so that whenever a spawned claude (re)starts a session — startup, resume, and
 * crucially `/clear` (which rotates to a BRAND-NEW session id + transcript) —
 * it writes the CURRENT claude session id back to a link file the sidecar
 * watches. That lets ATeam follow the rotation instead of tracking a frozen
 * pre-clear transcript (which otherwise goes stale → hidden by the active
 * window → the session appears lost).
 *
 * Attribution is exact: ATeam sets a unique `ATEAM_SESSION` env var per PTY at
 * spawn, so even multiple claude sessions in one cwd never get confused.
 *
 * Reads the hook JSON on stdin ({ session_id, cwd, source, ... }) and writes
 * `<ATEAM_HOME>/session-links/<ATEAM_SESSION>.json`. Best-effort: any failure
 * exits 0 so it never blocks or breaks the session.
 *
 * `clear` and `resume` ALSO re-inject the human's recall text (the same
 * knowledge-index prompt `manager.spawn()` passes via `--append-system-prompt`
 * at process launch) by printing it to stdout — Claude Code adds a
 * SessionStart hook's stdout to the model's context with system-prompt-level
 * weight. `/clear` wipes whatever the launch flag set with nothing to replace
 * it; `--resume` drops the flag outright (measured — see
 * `recallNeedsReinjection`). Without this the human's knowledge index and the
 * working method would be whatever the session was BORN with, forever.
 * `manager.ts` sets ATEAM_HUMAN_ID/ATEAM_DIRECTORYLESS alongside ATEAM_SESSION
 * so this can call the exact same `recallPrompt()` core uses at spawn.
 *
 * The same script is also the `PreCompact` hook, and `compact` is a SessionStart
 * source too: Claude Code's own compaction must not summarize away what the
 * session learned — see `compactKeepFor` / `compactSaveFor` in core.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compactKeepFor, compactSaveFor, recallFor, recallNeedsReinjection } from '@ateam/core';

function ateamHome(): string {
  return process.env.ATEAM_HOME ?? join(homedir(), '.ateam');
}

// Claude Code's stdout-as-context cap for hooks; stay comfortably under it.
const MAX_CONTEXT_CHARS = 9_000;

function reinjectRecall(cwd?: string, afterCompact = false): void {
  const humanId = process.env.ATEAM_HUMAN_ID;
  if (!humanId) return;
  const recall = recallFor(humanId, {
    ...(cwd ? { cwd } : {}),
    directoryless: process.env.ATEAM_DIRECTORYLESS === '1',
  });
  // after a compaction, what to do with the summary's "Experience to keep"
  // goes FIRST: the recall may be cut at the cap, this must not be
  const save = afterCompact ? compactSaveFor(humanId) : undefined;
  const text = [save, recall].filter(Boolean).join('\n\n');
  if (!text) return;
  process.stdout.write(
    text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n…(truncated)` : text,
  );
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  input += c;
});
process.stdin.on('end', () => {
  try {
    const ateam = process.env.ATEAM_SESSION;
    if (!ateam) return;
    const hook = input.trim() ? (JSON.parse(input) as Record<string, unknown>) : {};
    // PreCompact: Claude Code is about to summarize the conversation. What
    // this prints is merged into the summary's instructions — ask it to keep
    // what was learned. Not a session change, so no link file.
    if (hook.hook_event_name === 'PreCompact') {
      const humanId = process.env.ATEAM_HUMAN_ID;
      const keep = humanId ? compactKeepFor(humanId) : undefined;
      if (keep) process.stdout.write(keep);
      return;
    }
    const claudeSessionId = typeof hook.session_id === 'string' ? hook.session_id : '';
    if (!claudeSessionId) return;
    const dir = join(ateamHome(), 'session-links');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${ateam}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        claudeSessionId,
        cwd: typeof hook.cwd === 'string' ? hook.cwd : undefined,
        source: typeof hook.source === 'string' ? hook.source : undefined,
        // Who is reporting. Ateam honours a rotation only from inside the
        // session's own PTY tree: the ATEAM_SESSION marker and this hook are
        // inherited by anything that forks the conversation (the Claude app's
        // background agents do), and such a fork must not take over the row.
        pid: process.pid,
        ppid: process.ppid,
        at: Date.now(),
      }),
    );
    renameSync(tmp, file); // atomic — the watcher never sees a torn file
    const source = typeof hook.source === 'string' ? hook.source : undefined;
    if (recallNeedsReinjection(source)) {
      reinjectRecall(typeof hook.cwd === 'string' ? hook.cwd : undefined, source === 'compact');
    }
  } catch {
    /* best-effort — never block the session */
  } finally {
    process.exit(0);
  }
});
