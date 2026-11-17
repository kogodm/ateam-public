import { execFileSync } from 'node:child_process';

/**
 * Whether one process descends from another.
 *
 * Ateam follows a claude session-id rotation by trusting a report from its own
 * SessionStart hook: the hook runs inside the session's claude process and
 * writes `<ateamSessionId>.json` naming the current conversation. That is the
 * only way to survive `/clear`, which rotates the id inside the same process.
 *
 * The trust needs a bound. When the Claude desktop app forks one of Ateam's
 * conversations into a background agent, the fork inherits both the `--settings`
 * carrying that hook and the ATEAM_SESSION marker naming the row — so the hook
 * fires from a process Ateam never launched and reports an id Ateam does not
 * own. Seen 2026-09-10: a session was silently re-pointed at a background agent
 * and could no longer be opened, because `claude --resume` refuses a
 * conversation that is already running as one.
 *
 * So a report is honoured only when it comes from inside the session's own PTY
 * process tree. The hook may be a grandchild (a shell wrapper), hence the walk.
 */

/** how far up to look before giving up — a hook is a child or grandchild */
const MAX_HOPS = 6;

/** A process's parent pid, or undefined when it is gone / unknowable. */
export function parentPid(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
      .toString()
      .trim();
    const n = Number.parseInt(out, 10);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined; // no such process, or ps unavailable
  }
}

/**
 * True when `pid` is `ancestor`, or descends from it within MAX_HOPS.
 * `readParent` is injectable so the walk can be tested without processes.
 */
export function isDescendantOf(
  pid: number | undefined,
  ancestor: number | undefined,
  readParent: (p: number) => number | undefined = parentPid,
): boolean {
  if (!pid || !ancestor) return false;
  let cur = pid;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (cur === ancestor) return true;
    const next = readParent(cur);
    if (!next || next === cur || next <= 1) return false;
    cur = next;
  }
  return false;
}
