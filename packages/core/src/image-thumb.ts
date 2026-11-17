import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { readFileForView, resolveHome } from './fsview';
import { ateamHome } from './paths';

const run = promisify(execFile);

/**
 * A small JPEG of an image, for showing it inline.
 *
 * The stream used to send every picture whole, base64 over the socket: a
 * 3MB screenshot per bubble, which on a phone through the relay is most of
 * the wait. Inline, a picture is a few hundred pixels wide — the original is
 * fetched only when it is opened full screen.
 *
 * Made with macOS's own `sips` (no image library in the sidecar) and cached
 * under ~/.ateam/cache/thumbs by path + size + mtime + edge, so each picture
 * is scaled once. Anywhere `sips` is not there, or for an image already small
 * or animated, the original is returned as it would be by file.read.
 */
export type ThumbResult = ReturnType<typeof readFileForView> & {
  /** the picture was scaled down; the original is `size` bytes */
  thumb?: boolean;
};

/** below this the original is cheaper than a round of scaling */
const SMALL_BYTES = 200 * 1024;
const SCALABLE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.heic', '.tif', '.tiff']);

/**
 * The long edge to give `sips -Z` so the copy is `edge` px WIDE (a bubble is
 * limited by width) and at most 6×`edge` tall. Capping the long edge alone
 * made a 1280×8100 contact sheet 114px wide — blurred before anyone zoomed.
 */
export function scaledLongEdge(width: number, height: number, edge: number): number {
  if (!(width > 0 && height > 0)) return edge;
  const k = Math.min(1, edge / width, (6 * edge) / height);
  return Math.max(1, Math.round(Math.max(width, height) * k));
}

async function longEdgeFor(path: string, edge: number): Promise<number> {
  try {
    const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], {
      timeout: 10_000,
    });
    const w = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
    return scaledLongEdge(w, h, edge);
  } catch {
    return edge;
  }
}

/** the cache never grows past this… */
const CACHE_MAX_BYTES = 200 * 1024 * 1024;
/** …and forgets a copy not used for this long */
const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** a scan of the folder at most this often */
const PRUNE_EVERY_MS = 10 * 60 * 1000;
let lastPrune = 0;

/**
 * Keep the copies from piling up: drop those unused for a week, then the
 * least recently used until the folder is under its cap. A copy's mtime is
 * its last use (a hit touches it). Runs after a new copy is written, at most
 * every ten minutes — cheap next to the `sips` run it follows.
 */
export function pruneThumbCache(
  dir: string,
  now: number,
  opts: { maxBytes?: number; maxAgeMs?: number; force?: boolean } = {},
): { removed: number; keptBytes: number } {
  if (!opts.force && now - lastPrune < PRUNE_EVERY_MS) return { removed: 0, keptBytes: -1 };
  lastPrune = now;
  const maxBytes = opts.maxBytes ?? CACHE_MAX_BYTES;
  const maxAge = opts.maxAgeMs ?? CACHE_MAX_AGE_MS;
  let files: { path: string; size: number; used: number }[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jpg')) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        files.push({ path, size: st.size, used: st.mtimeMs });
      } catch {
        /* vanished */
      }
    }
  } catch {
    return { removed: 0, keptBytes: 0 };
  }
  let removed = 0;
  const drop = (path: string): void => {
    try {
      rmSync(path, { force: true });
      removed++;
    } catch {
      /* in use or gone */
    }
  };
  files = files.filter((f) => {
    if (now - f.used <= maxAge) return true;
    drop(f.path);
    return false;
  });
  files.sort((a, b) => a.used - b.used); // oldest use first
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files) {
    if (total <= maxBytes) break;
    drop(f.path);
    total -= f.size;
  }
  return { removed, keptBytes: total };
}

export async function readImageThumb(path: string, maxEdge = 640): Promise<ThumbResult> {
  const full = resolveHome(path);
  const st = statSync(full);
  const ext = extname(full).toLowerCase();
  const edge = Math.min(Math.max(Math.round(maxEdge), 64), 8192);
  if (process.platform !== 'darwin' || st.size < SMALL_BYTES || !SCALABLE.has(ext))
    return readFileForView(full);
  const dir = join(ateamHome(), 'cache', 'thumbs');
  // "|w": sized by width since 09-18 — older copies were sized by the long edge
  const key = createHash('sha1').update(`${full}|${st.size}|${st.mtimeMs}|${edge}|w`).digest('hex');
  const out = join(dir, `${key}.jpg`);
  // hits alone must keep the folder tidy too (throttled inside)
  if (existsSync(dir)) pruneThumbCache(dir, Date.now());
  try {
    if (!existsSync(out)) {
      mkdirSync(dir, { recursive: true });
      const target = await longEdgeFor(full, edge);
      await run(
        'sips',
        [
          '-Z',
          String(target),
          '-s',
          'format',
          'jpeg',
          '-s',
          'formatOptions',
          '70',
          full,
          '--out',
          out,
        ],
        { timeout: 20_000 },
      );
    } else {
      // a hit counts as a use: the pruning below goes by last use, not birth
      try {
        const now = new Date();
        utimesSync(out, now, now);
      } catch {
        /* removed under us — still readable below or not at all */
      }
    }
    const base64 = readFileSync(out).toString('base64');
    return {
      path: full,
      kind: 'image',
      base64,
      mime: 'image/jpeg',
      size: st.size,
      mtime: st.mtime.toISOString(),
      thumb: true,
    };
  } catch {
    return readFileForView(full); // not an image sips can read — send it as is
  }
}
