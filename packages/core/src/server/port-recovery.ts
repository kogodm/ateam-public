import { execFileSync } from 'node:child_process';

/**
 * Getting the LAN port back when something already holds it.
 *
 * The common case is not contention at all: the app was just restarted and its
 * PREVIOUS sidecar is still letting go of the socket. One retry loop covers it
 * and the port never changes. What made this worth writing is that a single
 * lost race used to be permanent — `startLanServer` rejected on the first
 * EADDRINUSE, the pane read "Not running", and remote access stayed dead until
 * somebody noticed (2026-08-27, on two machines).
 *
 * Beyond the retry the holder decides what happens:
 *
 *  - OUR OWN stale sidecar, orphaned by an app that has already quit, is dead
 *    weight: its sessions are on disk and no window can reach it. Killing it
 *    keeps the port stable, which matters — moving instead would leave the
 *    zombie answering on the port every saved phone bookmark still points at,
 *    and "two servers, one address" is the exact confusion this whole area
 *    already cost a day to untangle.
 *  - Anything else is not ours to kill. We move.
 *
 * And a deadline over all of it: whatever the holder is, service availability
 * wins after 30s — take a fresh port, write it to config, say why. The relay
 * tunnel follows the config, so remote access survives a move untouched; only
 * a bookmarked LAN address goes stale.
 */
export const PORT_DEADLINE_MS = 30_000;

export type Recovery =
  | { step: 'retry'; delayMs: number }
  | { step: 'kill'; pid: number }
  | { step: 'move' };

export function nextRecovery(args: {
  /** binds already attempted and failed */
  attempt: number;
  elapsedMs: number;
  deadlineMs?: number;
  /** who holds the port, when we could find out */
  holder?: { pid: number; ours: boolean };
  /** pids we have already tried to kill — never twice */
  killed?: readonly number[];
}): Recovery {
  const { attempt, elapsedMs, holder } = args;
  const deadlineMs = args.deadlineMs ?? PORT_DEADLINE_MS;
  const killed = args.killed ?? [];
  // availability wins: out of time, take any free port
  if (elapsedMs >= deadlineMs) return { step: 'move' };
  if (holder?.ours && !killed.includes(holder.pid)) return { step: 'kill', pid: holder.pid };
  // 250ms, 500ms, then a steady second — and never sleep past the deadline
  const delay = Math.min(1000, 250 * 2 ** Math.min(attempt, 2));
  return { step: 'retry', delayMs: Math.min(delay, deadlineMs - elapsedMs) };
}

/** The process listening on `port`, and whether it is another copy of OUR
 *  sidecar binary (same executable as this process). Undefined when nothing
 *  holds it or the platform gives us no way to ask — the ladder then just
 *  retries to the deadline and moves, which is the safe path anyway. */
export function findHolder(port: number): { pid: number; ours: boolean } | undefined {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = Number(out.split('\n')[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return undefined;
    const exe = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { pid, ours: exe === process.execPath };
  } catch {
    return undefined; // no lsof, no permission, nothing listening
  }
}

/** Best-effort TERM. Never throws: a holder we cannot kill just means the
 *  ladder keeps going and ends on a new port. */
export function killHolder(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone, or not ours to signal */
  }
}
