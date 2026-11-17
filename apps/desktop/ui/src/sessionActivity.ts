/**
 * Epoch-ms the sidebar's recently-active filter (and the row's "ago" badge)
 * should key off.
 *
 * Prefer real conversation activity (`lastActiveAt` from the CLI transcript /
 * a live turn this run). Fall back to `createdAt` only when nothing has spoken
 * yet, so a freshly spawned empty session is not hidden. Never invent "now":
 * restored sessions missing both stamps used to fall through to first-seen =
 * Date.now() and forever pass a 24h filter.
 */
export function sessionActivityMs(opts: {
  lastActiveAt?: string;
  createdAt?: string;
  lastTurnMs?: number;
}): number {
  const disk = opts.lastActiveAt ? Date.parse(opts.lastActiveAt) : Number.NaN;
  const turn = opts.lastTurnMs && opts.lastTurnMs > 0 ? opts.lastTurnMs : 0;
  const activity = Math.max(Number.isFinite(disk) ? disk : 0, turn);
  if (activity > 0) return activity;
  const created = opts.createdAt ? Date.parse(opts.createdAt) : Number.NaN;
  return Number.isFinite(created) ? created : 0;
}

/** True when `activityMs` falls inside the configured window (hours). */
export function isWithinActiveWindow(
  activityMs: number,
  windowHours: number,
  now = Date.now(),
): boolean {
  if (activityMs <= 0 || !(windowHours > 0)) return false;
  return now - activityMs < windowHours * 60 * 60 * 1000;
}
