import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { ateamHome } from './paths';

export interface GitInfo {
  branch: string;
  ahead: number;
  behind: number;
  files: { xy: string; path: string }[];
}
export interface TreeEntry {
  path: string;
  depth: number;
  dir: boolean;
}
export interface WorkspaceInfo {
  dir: string;
  git: GitInfo | null;
  tree: TreeEntry[];
}

// Only TRUE noise is hidden. `dist` / `build` / `coverage` are NOT here on
// purpose: in non-JS projects they are ordinary content folders (a marketing
// repo's `dist/` of exported assets) and hiding them read as "the tree lost my
// folder" — they load lazily like any other dir anyway.
const SKIP = new Set(['node_modules', '.git', '.next', '.venv', '.turbo', '.DS_Store']);

/** Every `git` read in this file goes through here.
 *
 *  maxBuffer is the point: Node's execFileSync defaults to 1 MB, and a repo
 *  with a big working tree blows past it — `git status --porcelain` in a
 *  21 GB tree with 35k changed files emits 3.1 MB, the call threw ENOBUFS,
 *  the catch swallowed it, and the Git panel silently rendered NOTHING above
 *  the log (real report, 2026-08-19). Reads here are all bounded in practice,
 *  so a generous ceiling costs nothing and removes a whole class of
 *  "works on my small repo" failures. Returns null when git fails. */
function git(dir: string, args: string[], timeout = 4000): string | null {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch {
    return null;
  }
}

function gitStatus(dir: string): GitInfo | null {
  const raw = git(dir, ['status', '--porcelain=v1', '-b']);
  if (raw === null) return null; // not a git repo / git missing
  const lines = raw.split('\n').filter(Boolean);
  const info: GitInfo = { branch: '', ahead: 0, behind: 0, files: [] };
  for (const ln of lines) {
    if (ln.startsWith('## ')) {
      const head = ln.slice(3);
      info.branch = head.split(/\.{3}|\s/)[0] ?? head;
      info.ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
      info.behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
    } else if (info.files.length < 60) {
      info.files.push({ xy: ln.slice(0, 2), path: ln.slice(3) });
    }
  }
  return info;
}

/** Git repos to offer in the panel's repo switcher for a workspace dir. If
 *  `dir` is itself a repo, that's the whole list — we don't dig inside it, so
 *  submodules / vendored repos aren't offered as switch targets. Otherwise we
 *  shallow-scan descendants (skipping the heavy SKIP dirs, not descending into
 *  a repo once found) so a parent folder that merely *holds* several repos
 *  still surfaces them. Depth- and count-capped to stay cheap. */
export function discoverRepos(dir: string): string[] {
  const isRepo = (d: string): boolean => existsSync(join(d, '.git'));
  if (isRepo(dir)) return [dir];
  const MAX = 50;
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 2 || out.length >= MAX) return;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return; // unreadable dir — skip
    }
    for (const name of names) {
      if (SKIP.has(name) || out.length >= MAX) continue;
      const child = join(d, name);
      let isDir: boolean;
      try {
        isDir = statSync(child).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (isRepo(child)) out.push(child);
      else walk(child, depth + 1); // only descend into non-repo dirs
    }
  };
  walk(dir, 1);
  return out.sort();
}

/** Shallow workspace tree. The cap is spent BREADTH-first — every
 *  top-level entry always makes it in, then level 2, … — because a
 *  depth-first cap starves later top-level siblings: the first big
 *  subtree eats the whole budget and the tree LOOKS truncated at the
 *  root (real bug with collapsed-by-default rendering). The returned
 *  array is still DFS-ordered (children right after their parent) —
 *  the UI's collapse sweep depends on that. */
export function fileTree(dir: string, maxDepth = 2, cap = 500): TreeEntry[] {
  interface Node extends TreeEntry {
    children: Node[];
  }
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  let count = 0;
  const roots: Node[] = [];
  const queue: { abs: string; rel: string; depth: number; bucket: Node[] }[] = [
    { abs: dir, rel: '', depth: 0, bucket: roots },
  ];
  while (queue.length && count < cap) {
    const { abs, rel, depth, bucket } = queue.shift() as (typeof queue)[number];
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name < b.name ? -1 : 1;
    });
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      if (count >= cap) break;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      const node: Node = { path: r, depth, dir: isDir, children: [] };
      bucket.push(node);
      count++;
      if (isDir && depth < maxDepth) {
        queue.push({ abs: join(abs, e.name), rel: r, depth: depth + 1, bucket: node.children });
      }
    }
  }
  const out: TreeEntry[] = [];
  const emit = (ns: Node[]): void => {
    for (const n of ns) {
      out.push({ path: n.path, depth: n.depth, dir: n.dir });
      emit(n.children);
    }
  };
  emit(roots);
  return out;
}

export interface GitLogCommit {
  hash: string;
  parents: string[];
  refs: string[];
  subject: string;
  author: string;
  at: string;
}

/** Recent commits, newest first. \x1f (unit separator) delimits fields —
 *  it can't appear in subjects/names, unlike any printable delimiter.
 *  `--all` (all branches/remotes/tags, not just HEAD's line) + `--topo-order`
 *  (children strictly before parents) so the desktop's branch-graph lane
 *  layout sees the whole DAG in the order its algorithm requires. */
export function gitLog(dir: string, limit = 100): GitLogCommit[] {
  const raw = git(dir, [
    'log',
    '--all',
    '--topo-order',
    '-n',
    String(limit),
    '--date=iso-strict',
    '--pretty=format:%H\x1f%P\x1f%D\x1f%an\x1f%ad\x1f%s',
  ]);
  if (raw === null) return []; // not a git repo / empty repo / git missing
  const out: GitLogCommit[] = [];
  for (const line of raw.split('\n')) {
    const [hash, parents, refs, author, at, subject] = line.split('\x1f');
    if (!hash) continue;
    out.push({
      hash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      refs: refs ? refs.split(', ').filter(Boolean) : [],
      author: author ?? '',
      at: at ?? '',
      subject: subject ?? '',
    });
  }
  return out;
}

/** Files touched by one commit (status letter + path). For renames git
 *  emits `R<score>\told\tnew` — we show the new path with status R. */
export function commitFiles(dir: string, hash: string): { status: string; path: string }[] {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return [];
  const raw = git(dir, ['show', '--name-status', '--pretty=format:', hash]);
  if (raw === null) return [];
  const out: { status: string; path: string }[] = [];
  for (const line of raw.split('\n')) {
    const m = /^([A-Z])\S*\t([^\t]+)(?:\t(.+))?$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    out.push({ status: m[1], path: m[3] ?? m[2] });
    if (out.length >= 200) break;
  }
  return out;
}

const repoGroupCache = new Map<string, { key: string; name: string }>();

/**
 * The dir → repo mapping, kept across launches.
 *
 * Resolving it costs one `git rev-parse` fork per distinct directory: with 26
 * projects that measured ~433ms, paid on the FIRST tree build of every launch —
 * i.e. right in the middle of restoring sessions. The answer almost never
 * changes, so it does not have to be recomputed every time the app starts.
 *
 * Only POSITIVE results are stored. "This is not a repo" is exactly the answer
 * that goes stale — the user runs `git init` there next week — and it is the
 * cheap case anyway (a failing rev-parse returns fast), so it stays in memory
 * for the run and is re-derived on the next launch.
 */
const REPO_GROUPS_VERSION = 1;
/** bound: this is a convenience cache, not a record */
const MAX_REPO_GROUPS = 500;
let repoGroupsLoaded = false;
let repoGroupsDirty = false;
let repoGroupsSaveTimer: ReturnType<typeof setTimeout> | undefined;

function repoGroupsFile(): string {
  return join(ateamHome(), 'repo-groups.json');
}

function loadRepoGroups(): void {
  if (repoGroupsLoaded) return;
  repoGroupsLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(repoGroupsFile(), 'utf8')) as {
      version?: number;
      entries?: Record<string, { key: string; name: string }>;
    };
    if (raw.version !== REPO_GROUPS_VERSION || !raw.entries) return;
    for (const [dir, group] of Object.entries(raw.entries)) {
      // The key IS the repo's .git path; if that is gone the repo moved or was
      // deleted, and the stored grouping would put sessions under a project
      // that no longer exists. Drop it and let it re-resolve.
      if (!group?.key || !group.name || !existsSync(group.key)) continue;
      repoGroupCache.set(dir, group);
    }
  } catch {
    /* absent or unreadable — every dir simply resolves the slow way once */
  }
}

/** Debounced so a tree build that resolves 26 dirs writes the file once. */
function scheduleRepoGroupsSave(): void {
  repoGroupsDirty = true;
  if (repoGroupsSaveTimer) return;
  repoGroupsSaveTimer = setTimeout(() => {
    repoGroupsSaveTimer = undefined;
    if (!repoGroupsDirty) return;
    repoGroupsDirty = false;
    try {
      const entries: Record<string, { key: string; name: string }> = {};
      let n = 0;
      for (const [dir, group] of repoGroupCache) {
        if (group.key === dir) continue; // negative result — never persisted
        if (n++ >= MAX_REPO_GROUPS) break;
        entries[dir] = group;
      }
      mkdirSync(ateamHome(), { recursive: true });
      const tmp = `${repoGroupsFile()}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: REPO_GROUPS_VERSION, entries }, null, 2));
      renameSync(tmp, repoGroupsFile()); // atomic: a torn file would lose the lot
    } catch {
      /* best effort — the mapping is re-derivable */
    }
  }, 1000);
  repoGroupsSaveTimer.unref?.();
}

/** test seam: forget everything learned this run (simulates a fresh launch) */
export function clearRepoGroupCache(): void {
  repoGroupCache.clear();
  repoGroupsLoaded = false;
}

/**
 * Stable project GROUP for a dir: all linked worktrees of one repo share it
 * (keyed by the common `.git` dir), so a worktree's sessions list under the
 * SAME project as the primary checkout instead of splitting into their own.
 * `name` is the main checkout's folder name. Falls back to the dir itself
 * when it isn't a git repo. Cached — a path's repo doesn't change at runtime.
 *
 * IMPORTANT: this is a display/grouping key ONLY. A session's real `cwd` (the
 * worktree path) is never derived from this — that's what keeps resume/persist
 * pointing at the right transcript.
 */
/**
 * Is there any `.git` above this dir? A few existsSync calls, versus ~14ms to
 * fork git and have it tell us the same thing. The dirs that are NOT in a repo
 * are exactly the ones whose answer cannot be cached across launches (someone
 * runs `git init` there next week), so they used to pay the fork on every
 * single launch — this asks the filesystem instead, every time, for free.
 *
 * A worktree's `.git` is a FILE, a normal repo's is a directory: existsSync
 * covers both. Only a positive answer leads to the fork that resolves the
 * real common dir.
 */
function hasGitAncestor(dir: string): boolean {
  if (!existsSync(dir)) return false; // a workspace that has since moved away
  let cur = dir;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, '.git'))) return true;
    const parent = cur.slice(0, cur.lastIndexOf('/'));
    if (!parent || parent === cur) return false;
    cur = parent;
  }
  return false;
}

export function repoGroup(dir: string): { key: string; name: string } {
  loadRepoGroups();
  const hit = repoGroupCache.get(dir);
  if (hit) return hit;
  const group0 = { key: dir, name: basename(dir.replace(/\/+$/, '')) || 'project' };
  if (!hasGitAncestor(dir)) {
    repoGroupCache.set(dir, group0);
    return group0; // not in a repo — nothing to persist, nothing to fork
  }
  let group = group0;
  try {
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    })
      .toString()
      .trim();
    if (common) {
      let abs = common.startsWith('/') ? common : join(dir, common);
      // canonicalize: a linked worktree reports the common dir already
      // realpath'd, while the main checkout's joined `.git` is not — without
      // this they'd differ by macOS's /var→/private/var (etc.) symlink and
      // fail to group together.
      try {
        abs = realpathSync(abs);
      } catch {
        /* .git vanished mid-call — use the unresolved path */
      }
      const root = abs.replace(/\/\.git\/?$/, '');
      group = { key: abs, name: basename(root) || group.name };
    }
  } catch {
    /* not a git repo — group by its own path */
  }
  repoGroupCache.set(dir, group);
  if (group.key !== dir) scheduleRepoGroupsSave(); // resolved to a real repo
  return group;
}

export interface GitRemote {
  name: string;
  url: string;
}

/** Remotes (name → fetch URL), origin first. Empty when none / not a repo. */
export function gitRemotes(dir: string): GitRemote[] {
  let raw: string;
  try {
    raw = git(dir, ['remote', '-v']) ?? '';
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: GitRemote[] = [];
  for (const ln of raw.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(ln);
    if (m?.[1] && m[2] && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ name: m[1], url: m[2] });
    }
  }
  return out.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
}

/** Local branches + the current one (empty current = detached HEAD). */
export function gitBranches(dir: string): { current: string; branches: string[] } {
  let branches: string[] = [];
  try {
    branches = (git(dir, ['branch', '--format=%(refname:short)']) ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return { current: '', branches: [] };
  }
  let current = '';
  try {
    current = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    })
      .toString()
      .trim();
  } catch {
    /* detached / no HEAD */
  }
  return { current: current === 'HEAD' ? '' : current, branches };
}

/** Switch branches. Returns git's stderr (dirty tree, unknown branch…) on
 *  failure so the UI can surface it instead of silently no-op'ing. */
export function gitCheckout(dir: string, branch: string): { ok: boolean; err?: string } {
  try {
    execFileSync('git', ['-C', dir, 'checkout', branch], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return { ok: true };
  } catch (e) {
    const stderr =
      e && typeof e === 'object' && 'stderr' in e
        ? String((e as { stderr?: Buffer }).stderr ?? '')
        : String(e);
    return { ok: false, err: stderr.trim().split('\n').slice(0, 4).join('\n') || 'checkout failed' };
  }
}

export interface GitWorktree {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
}

/** Linked worktrees (`git worktree list --porcelain`). */
export function gitWorktrees(dir: string): GitWorktree[] {
  let raw: string;
  try {
    raw = git(dir, ['worktree', 'list', '--porcelain']) ?? '';
  } catch {
    return [];
  }
  const out: GitWorktree[] = [];
  let cur: Partial<GitWorktree> | null = null;
  const flush = (): void => {
    if (cur?.path)
      out.push({
        path: cur.path,
        head: cur.head ?? '',
        branch: cur.branch,
        bare: cur.bare === true,
        detached: cur.detached === true,
      });
  };
  for (const ln of raw.split('\n')) {
    if (ln.startsWith('worktree ')) {
      flush();
      cur = { path: ln.slice(9) };
    } else if (!cur) {
      /* skip until first worktree line */
    } else if (ln.startsWith('HEAD ')) cur.head = ln.slice(5);
    else if (ln.startsWith('branch ')) cur.branch = ln.slice(7).replace(/^refs\/heads\//, '');
    else if (ln === 'bare') cur.bare = true;
    else if (ln === 'detached') cur.detached = true;
  }
  flush();
  return out;
}

const DIFF_CAP = 400 * 1024;
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function repoRoot(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Before/after base64 for an image file — `git show <rev>:<path>` needs a
 *  path relative to the repo ROOT (unlike plain `git diff -- <path>`, which
 *  accepts an absolute path fine), so this resolves the toplevel first. */
function gitImageDiff(
  dir: string,
  path: string,
  hash: string | undefined,
): { diff: string; truncated: boolean; image?: { before?: string; after?: string; mime: string } } {
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (!mime) return { diff: '', truncated: false };
  const root = repoRoot(dir);
  if (!root) return { diff: '', truncated: false };
  // realpath BOTH sides before computing the relative path — `dir`/`path`
  // may come in through a symlinked prefix (e.g. macOS /tmp -> /private/tmp)
  // that doesn't literally match git's (already-resolved) toplevel output,
  // which would otherwise produce a bogus relative path with stray `..`.
  const rawAbsPath = path.startsWith('/') ? path : join(dir, path);
  let absPath: string;
  try {
    absPath = realpathSync(rawAbsPath);
  } catch {
    absPath = rawAbsPath; // deleted from disk — realpath fails, fall back
  }
  const relPath = relative(root, absPath).split(sep).join('/');
  const showBlob = (rev: string): string | undefined => {
    try {
      return execFileSync('git', ['-C', root, 'show', `${rev}:${relPath}`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        maxBuffer: 20 * 1024 * 1024,
      }).toString('base64');
    } catch {
      return undefined; // e.g. new file — no such blob at that rev
    }
  };
  let before: string | undefined;
  let after: string | undefined;
  if (hash) {
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) return { diff: '', truncated: false };
    before = showBlob(`${hash}^`);
    after = showBlob(hash);
  } else {
    before = showBlob('HEAD');
    try {
      after = readFileSync(absPath).toString('base64');
    } catch {
      after = undefined; // deleted in the working tree
    }
  }
  if (!before && !after) return { diff: '', truncated: false };
  return { diff: '', truncated: false, image: { before, after, mime } };
}

/** Unified diff for one file — or, for an image file, before/after base64
 *  (see gitImageDiff) instead of a text diff.
 *  - no hash → working tree vs HEAD (`git diff HEAD -- path`); untracked
 *    files (nothing vs HEAD) fall back to `diff --no-index /dev/null path`
 *    so brand-new files still render as an all-added diff.
 *  - hash → that commit's change to the file (`git show <hash> -- path`). */
export function gitDiff(
  dir: string,
  path: string,
  hash?: string,
): { diff: string; truncated: boolean; image?: { before?: string; after?: string; mime: string } } {
  if (IMAGE_MIME[extname(path).toLowerCase()]) return gitImageDiff(dir, path, hash);
  const run = (...args: string[]): string => {
    try {
      return execFileSync('git', ['-C', dir, ...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      }).toString();
    } catch (e) {
      // `git diff --no-index` exits 1 WITH output when files differ —
      // that's a success for our purposes, not an error.
      const out = (e as { stdout?: Buffer }).stdout;
      return out ? out.toString() : '';
    }
  };
  let diff: string;
  if (hash) {
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) return { diff: '', truncated: false };
    diff = run('show', '--pretty=format:', '-p', hash, '--', path);
  } else {
    diff = run('diff', 'HEAD', '--', path);
    // Empty here means either "genuinely unchanged" or "untracked" — only
    // the untracked case should render as an all-added diff. Without this
    // check, ANY unchanged tracked file falls through to --no-index vs
    // /dev/null and renders as if the whole file were just added — this
    // bit FileView's automatic per-file diff fetch, which calls gitDiff on
    // every opened file regardless of whether it actually changed.
    if (!diff.trim() && !run('ls-files', '--', path).trim()) {
      diff = run('diff', '--no-index', '--', '/dev/null', path);
    }
  }
  if (diff.length > DIFF_CAP) return { diff: diff.slice(0, DIFF_CAP), truncated: true };
  return { diff, truncated: false };
}

const cache = new Map<string, { at: number; data: WorkspaceInfo }>();
const TTL_MS = 3000;

/** Git status + shallow file tree for a workspace dir (short-TTL cached).
 *  `fresh` bypasses the cache — used by fs.changed-driven refetches, which
 *  by definition know the cached copy is stale. */
export function workspaceInfo(dir: string, fresh = false): WorkspaceInfo {
  const hit = cache.get(dir);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const data: WorkspaceInfo = { dir, git: gitStatus(dir), tree: fileTree(dir) };
  cache.set(dir, { at: Date.now(), data });
  return data;
}
