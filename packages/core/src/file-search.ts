/**
 * Files under a directory, matched by name — what the stream composer's `@`
 * menu offers, the way the CLI's own `@` does.
 *
 * Everything here is asynchronous. A synchronous walk on the sidecar's one
 * thread once froze every RPC in the app (commit 689ca5a), so the listing is
 * `git ls-files` run as a child process, or, outside a repo, an async walk
 * with hard caps. Listings are cached per directory for a short while: the
 * menu asks again on every keystroke.
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_MS = 20_000;
/** a walk outside git stops here — a home directory is not a project */
const MAX_WALK_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 12;
const GIT_TIMEOUT_MS = 5_000;
/** never worth offering, and often huge */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  '.idea',
  '.DS_Store',
]);

interface Listing {
  at: number;
  /** relative paths; directories end in `/` */
  paths: string[];
}

const cache = new Map<string, Listing>();
const inFlight = new Map<string, Promise<string[]>>();

function gitFiles(dir: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-co', '--exclude-standard', '-z'],
      { cwd: dir, maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(null); // not a repo, or git missing
        resolve(stdout.split('\0').filter(Boolean));
      },
    );
  });
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }];
  let seen = 0;
  while (queue.length > 0 && seen < MAX_WALK_ENTRIES) {
    const { rel, depth } = queue.shift() as { rel: string; depth: number };
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > MAX_WALK_ENTRIES) break;
      if (SKIP_DIRS.has(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) queue.push({ rel: p, depth: depth + 1 });
      } else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

/** files plus every directory above them (`src/`, `src/ui/`) */
function withDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    let i = f.indexOf('/');
    while (i >= 0) {
      dirs.add(f.slice(0, i + 1));
      i = f.indexOf('/', i + 1);
    }
  }
  return [...dirs, ...files];
}

async function listing(dir: string, now: number): Promise<string[]> {
  const hit = cache.get(dir);
  if (hit && now - hit.at < CACHE_MS) return hit.paths;
  const pending = inFlight.get(dir);
  if (pending) return pending;
  const job = (async () => {
    const files = (await gitFiles(dir)) ?? (await walkFiles(dir));
    const paths = withDirs(files.filter((f) => !f.split('/').some((s) => SKIP_DIRS.has(s))));
    cache.set(dir, { at: Date.now(), paths });
    return paths;
  })().finally(() => inFlight.delete(dir));
  inFlight.set(dir, job);
  return job;
}

/** Higher is better; undefined = no match. Name matches beat path matches,
 *  which beat letters found in order; shorter paths win ties. */
export function scorePath(path: string, query: string): number | undefined {
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  const brevity = -path.length / 10;
  if (!q) return brevity - (path.split('/').length - 1) * 10; // shallow first
  if (base.startsWith(q)) return 1000 + brevity;
  if (base.includes(q)) return 800 + brevity;
  if (p.includes(q)) return 600 + brevity;
  // letters in order, fewer gaps better
  let at = -1;
  let gaps = 0;
  for (const ch of q) {
    const next = p.indexOf(ch, at + 1);
    if (next < 0) return undefined;
    if (at >= 0 && next > at + 1) gaps++;
    at = next;
  }
  return 300 - gaps * 10 + brevity;
}

export async function searchFiles(
  dir: string,
  query: string,
  limit = 20,
  now = Date.now(),
): Promise<string[]> {
  const paths = await listing(dir, now);
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const score = scorePath(path, query);
    if (score !== undefined) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => s.path);
}

/** tests only */
export function resetFileSearchCache(): void {
  cache.clear();
  inFlight.clear();
}
