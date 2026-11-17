import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ateamHome } from './paths';
import { listHumans } from './humans';

export type RecentSource = 'ateam' | 'claude' | 'cursor' | 'codex';
export interface RecentProject {
  dir: string;
  source: RecentSource;
  /** ISO-8601 last-seen/mtime (sort key) */
  when: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function mtime(p: string): string {
  try {
    return statSync(p).mtime.toISOString();
  } catch {
    return '';
  }
}
function newestJsonl(dir: string): string | undefined {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f));
    files.sort((a, b) => (mtime(a) < mtime(b) ? 1 : -1));
    return files[0];
  } catch {
    return undefined;
  }
}
/** Head-only line read so we never slurp a 100MB jsonl just to peek at the
 *  first few records. Drops the trailing partial line if the file is bigger. */
function headLines(file: string, bytes: number): string[] {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, 0);
    const ls = buf.toString('utf8').split('\n').filter(Boolean);
    if (len < size) ls.pop();
    return ls;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** First plausible existing-dir path found in `cwd|workdir|folder` of some lines. */
function cwdFromJsonl(file: string, max = 8): string | undefined {
  try {
    const lines = headLines(file, 64 * 1024).slice(0, max);
    for (const ln of lines) {
      try {
        const o = JSON.parse(ln) as Record<string, unknown>;
        for (const k of ['cwd', 'workdir', 'projectDir', 'folder']) {
          const v = o[k];
          if (typeof v === 'string' && v.startsWith('/') && isDir(v)) return v;
        }
      } catch {
        /* skip non-JSON */
      }
    }
  } catch {
    /* unreadable */
  }
  return undefined;
}

function fromClaude(): RecentProject[] {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return [];
  const out: RecentProject[] = [];
  try {
    for (const slug of readdirSync(root)) {
      const pdir = join(root, slug);
      if (!isDir(pdir)) continue;
      const j = newestJsonl(pdir);
      const cwd = j ? cwdFromJsonl(j) : undefined;
      if (cwd) out.push({ dir: cwd, source: 'claude', when: mtime(j ?? pdir) });
    }
  } catch {
    /* ignore */
  }
  return out;
}

function walkJsonl(root: string, depth: number, acc: string[]): void {
  if (depth < 0 || !existsSync(root)) return;
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const p = join(root, e.name);
      if (e.isDirectory()) walkJsonl(p, depth - 1, acc);
      else if (e.name.endsWith('.jsonl')) acc.push(p);
      if (acc.length > 400) return;
    }
  } catch {
    /* ignore */
  }
}
function fromCodex(): RecentProject[] {
  const base = join(homedir(), '.codex');
  if (!existsSync(base)) return [];
  const files: string[] = [];
  walkJsonl(join(base, 'sessions'), 5, files);
  if (existsSync(join(base, 'history.jsonl'))) files.push(join(base, 'history.jsonl'));
  const out: RecentProject[] = [];
  for (const f of files) {
    const cwd = cwdFromJsonl(f, 20);
    if (cwd) out.push({ dir: cwd, source: 'codex', when: mtime(f) });
  }
  return out;
}

function fromCursor(): RecentProject[] {
  const ws = join(
    homedir(),
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'workspaceStorage',
  );
  if (!existsSync(ws)) return [];
  const out: RecentProject[] = [];
  try {
    for (const d of readdirSync(ws)) {
      const wf = join(ws, d, 'workspace.json');
      if (!existsSync(wf)) continue;
      try {
        const o = JSON.parse(readFileSync(wf, 'utf8')) as { folder?: string };
        const uri = o.folder;
        if (typeof uri === 'string' && uri.startsWith('file://')) {
          const p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
          if (isDir(p)) out.push({ dir: p, source: 'cursor', when: mtime(wf) });
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function fromAteam(): RecentProject[] {
  const out: RecentProject[] = [];
  try {
    for (const h of listHumans())
      for (const p of h.projects) if (isDir(p.dir)) out.push({ dir: p.dir, source: 'ateam', when: p.lastSeen });
  } catch {
    /* ignore */
  }
  return out;
}

const SRC_RANK: Record<RecentSource, number> = { ateam: 3, claude: 2, cursor: 1, codex: 0 };

/** Aggregated recent project dirs, deduped (best source + newest), recency-sorted. */
export function recentProjects(limit = 40): RecentProject[] {
  const all = [...fromAteam(), ...fromClaude(), ...fromCursor(), ...fromCodex()];
  const best = new Map<string, RecentProject>();
  for (const r of all) {
    if (!isDir(r.dir)) continue;
    const cur = best.get(r.dir);
    if (
      !cur ||
      r.when > cur.when ||
      (r.when === cur.when && SRC_RANK[r.source] > SRC_RANK[cur.source])
    ) {
      best.set(r.dir, r);
    }
  }
  return [...best.values()]
    .sort((a, b) => (a.when < b.when ? 1 : -1))
    .slice(0, limit);
}
