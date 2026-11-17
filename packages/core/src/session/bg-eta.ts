import type { BgProgress } from './bg-progress';

/**
 * tqdm's `[02:13<00:31, 58.2it/s]` for a running command's progress.
 *
 * A figure read off a log says where the command is, not how fast it moves, so
 * the rate comes from watching the figure change across polls. Each task keeps
 * a short history of (time, value) samples:
 * - the rate is taken over the last WINDOW_MS — recent enough to follow a
 *   command that speeds up or slows down, long enough that one poll's jitter
 *   does not swing it;
 * - before there is a window worth trusting (a view just opened), it falls
 *   back to the average since the task started — tqdm's own first estimate;
 * - a figure that goes backwards or a total that changes is a new phase
 *   (`clip_l14 9471/9471` then `dinov2 12/9471`): the history restarts, and so
 *   does the since-start average, which would describe the phase before.
 *
 * When the output already carries tqdm's own `elapsed<remaining`, that is
 * used as is — it knows every iteration, the poll only sees a few.
 */

export interface BgTiming {
  /** seconds since the task started */
  elapsedSec?: number;
  /** seconds left at the current rate */
  etaSec?: number;
  /** items per second (N/M progress only — a percentage has no unit) */
  rate?: number;
}

export interface Sample {
  t: number;
  v: number;
}

interface Track {
  total?: number;
  samples: Sample[];
  /** the history restarted after the task began: the since-start average is void */
  phased: boolean;
  touched: number;
}

const WINDOW_MS = 120_000;
/** a window shorter than this is poll noise, not a rate */
const MIN_SPAN_MS = 8_000;
/** no movement for this long: the rate counts the stall too */
const STALL_MS = 30_000;
const FORGET_MS = 10 * 60_000;

const tracks = new Map<string, Track>();

/** `02:13<00:31, 58.20it/s` / `1:02:13<3:00:01` in a tqdm line */
const TQDM_RE = /(?:(\d+):)?(\d{1,2}):(\d{2})<(?:(\d+):)?(\d{1,2}):(\d{2})/;

function clockSec(h: string | undefined, m: string, s: string): number {
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
}

/** tqdm's own elapsed/remaining, when the progress line has them */
export function tqdmTiming(line: string): BgTiming | undefined {
  const m = TQDM_RE.exec(line);
  if (!m) return undefined;
  const [, eh, em, es, rh, rm, rs] = m;
  const rateM = /([\d.]+)\s*(?:it|[a-zA-Z]+)\/s/.exec(line.slice(m.index));
  return {
    elapsedSec: clockSec(eh, em as string, es as string),
    etaSec: clockSec(rh, rm as string, rs as string),
    ...(rateM ? { rate: Number(rateM[1]) } : {}),
  };
}

/** What else is known about the moment a figure was read. */
export interface ProgressContext {
  /** when the task began (its output file's birth) */
  startedAtMs?: number;
  /** when the file the figure came from was last written — the figure's own
   *  time, far closer than the poll's for a log that prints every few minutes */
  changedAtMs?: number;
  /** earlier figures of this phase with the times their lines were stamped */
  history?: Sample[];
}

const OPEN_ENDED = -1;

/** Feed one poll's progress for a task; get its timing back. */
export function observeProgress(
  key: string,
  progress: BgProgress,
  now: number,
  ctx: ProgressContext = {},
): BgTiming {
  forgetStale(now);
  const { startedAtMs, changedAtMs, history } = ctx;
  const counted = progress.done !== undefined;
  const v = counted ? (progress.done as number) : progress.pct;
  // a bare count has no end: track it under a total no real one can equal,
  // so it still gets a rate, and never a time left
  const total = counted ? (progress.total ?? OPEN_ENDED) : 100;
  const elapsedSec =
    startedAtMs !== undefined && now > startedAtMs
      ? Math.round((now - startedAtMs) / 1000)
      : undefined;
  if (v === undefined || total === undefined) return elapsedSec ? { elapsedSec } : {};

  let tr = tracks.get(key);
  const last = tr?.samples.at(-1);
  if (!tr || tr.total !== total || (last && v < last.v)) {
    const seed = (history ?? []).filter((h) => h.t <= now && h.v <= v);
    tr = { total, samples: seed, phased: !!tr, touched: now };
    tracks.set(key, tr);
  }
  tr.touched = now;
  const prev = tr.samples.at(-1);
  if (prev?.v !== v) {
    const t = Math.min(now, Math.max(changedAtMs ?? now, prev?.t ?? 0));
    tr.samples.push({ t, v });
  }
  // keep one sample older than the window: it anchors a full-window rate
  while (tr.samples.length > 2 && (tr.samples[1] as Sample).t <= now - WINDOW_MS)
    tr.samples.shift();

  const timing: BgTiming = elapsedSec ? { elapsedSec } : {};
  const r = rateOf(tr, now, startedAtMs);
  const remaining = total - v;
  if (r && r.perMs > 0 && total === OPEN_ENDED) {
    timing.rate = r.perMs * 1000;
  } else if (r && r.perMs > 0 && remaining > 0) {
    // still moving: it has kept going since its last figure was written
    timing.etaSec = Math.max(0, Math.round((remaining / r.perMs - r.sinceMs) / 1000));
    if (counted) timing.rate = r.perMs * 1000;
  }
  return timing;
}

function rateOf(
  tr: Track,
  now: number,
  startedAtMs?: number,
): { perMs: number; sinceMs: number } | undefined {
  const first = tr.samples[0] as Sample;
  const latest = tr.samples.at(-1) as Sample;
  const n = tr.samples.length;
  // a log that prints every 3 minutes is not stalled after 40 seconds
  const gap = n > 1 ? (latest.t - first.t) / (n - 1) : 0;
  const stalled = now - latest.t > Math.max(STALL_MS, 2 * gap);
  const end = stalled ? now : latest.t;
  const span = end - first.t;
  const sinceMs = stalled ? 0 : now - latest.t;
  if (n > 1 && span >= MIN_SPAN_MS && latest.v > first.v)
    return { perMs: (latest.v - first.v) / span, sinceMs };
  // not enough history yet: the average since the task began
  if (!tr.phased && startedAtMs !== undefined && now - startedAtMs >= MIN_SPAN_MS && latest.v > 0)
    return { perMs: latest.v / (now - startedAtMs), sinceMs: 0 };
  return undefined;
}

/** `2026-09-15 15:52:01,132 …` — the local time a log line was stamped with */
const STAMP_RE = /^\[?(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?/;
const FRAC_RE = /(?<![\w/.:-])(\d{1,9})\s*\/\s*(\d{1,9})(?![\w/.:-])/g;

/** Earlier figures of the current phase, from lines a logger stamped with the
 *  time: a history that exists before the first poll does. Walks back from the
 *  newest figure and stops where the phase changes (another total, or a figure
 *  larger than the one after it). */
export function stampedHistory(text: string, total: number): Sample[] {
  const out: Sample[] = [];
  const lines = text.split(/\r?\n|\r/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = (lines[i] as string).trim();
    const frac = [...l.matchAll(FRAC_RE)]
      .map((m) => ({ done: Number(m[1]), total: Number(m[2]) }))
      .filter((f) => f.total > 0 && f.done <= f.total)
      .at(-1);
    if (!frac) continue;
    if (frac.total !== total) break;
    const s = STAMP_RE.exec(l);
    if (!s) break;
    const [, y, mo, d, h, mi, se, frac10] = s;
    const ms = frac10 ? Number(frac10.padEnd(3, '0').slice(0, 3)) : 0;
    const t = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(se),
      ms,
    ).getTime();
    const next = out[0];
    if (next && (frac.done > next.v || t > next.t)) break;
    out.unshift({ t, v: frac.done });
  }
  return out;
}

function forgetStale(now: number): void {
  for (const [k, tr] of tracks) if (now - tr.touched > FORGET_MS) tracks.delete(k);
}

/** tests only */
export function resetProgressClock(): void {
  tracks.clear();
}
