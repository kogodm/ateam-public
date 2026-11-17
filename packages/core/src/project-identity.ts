import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ateamHome } from './paths';

/**
 * A project's portable identity: an id embedded in the project itself.
 *
 * Everything Ateam knew about a project used to key on its absolute path, so
 * the same repo on another machine — cloned somewhere else, named differently
 * — was a stranger, and two unrelated repos that happen to share a folder name
 * could be confused. The marker `<root>/.ateam/project.json` travels with the
 * project (it is committed with the repo by default), so the id decides "same
 * project" and names/paths are only labels. See docs/sync/design.md §1.
 *
 * Reading a marker has no side effects. Creating one writes a file into the
 * user's project, so callers do that only when sync is on.
 */

export interface ProjectMarker {
  id: string;
  name: string;
  createdAt: string;
}

export const MARKER_DIR = '.ateam';
export const MARKER_FILE = 'project.json';
const ID_RE = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isProjectId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
export const newProjectId = (): string => `prj_${randomUUID()}`;

function git(dir: string, args: string[]): string | undefined {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    })
      .toString()
      .trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Directories a marker must never be written into: a project there would put
 *  its `.ateam/` next to (or inside) Ateam's own home. */
function forbiddenRoot(dir: string): boolean {
  const d = real(resolve(dir));
  const home = real(homedir());
  return (
    d === '/' ||
    d === home ||
    d === real(dirname(ateamHome())) ||
    d.startsWith(`${real(ateamHome())}`)
  );
}

/** Where a new marker for `dir` goes: the top of the checkout `dir` is in (a
 *  linked worktree is its own checkout, so the file is committed with the
 *  work done there), or `dir` itself outside git. */
export function projectRoot(dir: string): string {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return real(top ?? resolve(dir));
}

/** The main checkout of the repo `dir` belongs to — where a worktree looks
 *  when its own checkout has no marker yet. Undefined outside git. */
function mainCheckout(dir: string): string | undefined {
  const common = git(dir, ['rev-parse', '--git-common-dir']);
  if (!common) return undefined;
  const abs = real(common.startsWith('/') ? common : join(dir, common));
  return abs.endsWith('/.git') ? abs.slice(0, -'/.git'.length) : undefined;
}

export type MarkerRead =
  | { kind: 'found'; root: string; marker: ProjectMarker }
  | { kind: 'absent' }
  /** a file is there but is not a marker we can trust — never overwritten:
   *  it is probably committed, and replacing it would rename the project on
   *  every device */
  | { kind: 'invalid'; path: string; reason: string };

function readMarkerAt(root: string): MarkerRead {
  const path = join(root, MARKER_DIR, MARKER_FILE);
  if (!existsSync(path)) return { kind: 'absent' };
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProjectMarker>;
    if (!isProjectId(o.id)) return { kind: 'invalid', path, reason: 'missing or malformed id' };
    return {
      kind: 'found',
      root,
      marker: {
        id: o.id,
        name: typeof o.name === 'string' && o.name ? o.name : basename(root),
        createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
      },
    };
  } catch (e) {
    return { kind: 'invalid', path, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The marker governing `dir`: the nearest one from `dir` up to its checkout
 *  root (a subfolder belongs to the project above it), then the repo's main
 *  checkout for a worktree that has none of its own. */
export function findProjectMarker(dir: string): MarkerRead {
  const start = real(resolve(dir));
  // Inside git the checkout top bounds the search (a repo nested in another
  // folder is its own project). Outside git there is no such boundary: walk
  // up until home, the way a subfolder of a plain project finds it.
  const top = git(start, ['rev-parse', '--show-toplevel']);
  const stopAt = top ? real(top) : undefined;
  let cur = start;
  for (let i = 0; i < 64; i++) {
    if (forbiddenRoot(cur)) break;
    const r = readMarkerAt(cur);
    if (r.kind !== 'absent') return r;
    if (cur === stopAt) break;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  const main = mainCheckout(start);
  if (main && main !== stopAt && !forbiddenRoot(main)) {
    const r = readMarkerAt(main);
    if (r.kind !== 'absent') return r;
  }
  return { kind: 'absent' };
}

export type EnsureResult =
  | { kind: 'found' | 'created'; root: string; marker: ProjectMarker }
  | { kind: 'invalid'; path: string; reason: string }
  | { kind: 'refused'; reason: string };

/** The project `dir` belongs to, creating its marker when there is none. */
export function ensureProjectMarker(dir: string, nameHint?: string): EnsureResult {
  const found = findProjectMarker(dir);
  if (found.kind === 'found') return found;
  if (found.kind === 'invalid') return found;
  const root = projectRoot(dir);
  if (forbiddenRoot(root)) return { kind: 'refused', reason: `not a project directory: ${root}` };
  const marker: ProjectMarker = {
    id: newProjectId(),
    name: (nameHint?.trim() || basename(mainCheckout(root) ?? root) || 'project').slice(0, 120),
    createdAt: new Date().toISOString(),
  };
  writeMarker(root, marker);
  return { kind: 'created', root, marker };
}

/** Point a folder at an existing project (the "link to project…" flow, or a
 *  device receiving a project it has not seen). Replaces an absent or invalid
 *  marker; refuses to silently re-id a folder that already has a valid one. */
export function linkProjectMarker(
  dir: string,
  marker: ProjectMarker,
  opts: { replace?: boolean } = {},
): EnsureResult {
  if (!isProjectId(marker.id)) return { kind: 'refused', reason: 'not a project id' };
  const root = projectRoot(dir);
  if (forbiddenRoot(root)) return { kind: 'refused', reason: `not a project directory: ${root}` };
  const cur = readMarkerAt(root);
  if (cur.kind === 'found' && cur.marker.id !== marker.id && !opts.replace) {
    return { kind: 'refused', reason: `already project ${cur.marker.id}` };
  }
  writeMarker(root, marker);
  return { kind: 'created', root, marker };
}

function writeMarker(root: string, marker: ProjectMarker): void {
  const dir = join(root, MARKER_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, MARKER_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`);
  renameSync(tmp, path);
}

/* ── the device-local index: which folders on THIS machine are which project ── */

interface IndexShape {
  version: 1;
  projects: Record<string, { name: string; dirs: string[]; lastSeen: string }>;
}

export const projectIndexPath = (): string => join(ateamHome(), 'project-paths.json');

function readIndex(): IndexShape {
  try {
    const o = JSON.parse(readFileSync(projectIndexPath(), 'utf8')) as IndexShape;
    if (o && o.version === 1 && o.projects && typeof o.projects === 'object') return o;
  } catch {
    /* absent or unreadable → start empty; it is rebuilt as projects are used */
  }
  return { version: 1, projects: {} };
}

function writeIndex(ix: IndexShape): void {
  mkdirSync(ateamHome(), { recursive: true });
  const path = projectIndexPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ix, null, 2));
  renameSync(tmp, path);
}

/** Remember that `root` on this device is project `marker.id`. */
export function recordProjectDir(marker: ProjectMarker, root: string): void {
  const ix = readIndex();
  const cur = ix.projects[marker.id] ?? { name: marker.name, dirs: [], lastSeen: '' };
  const dirs = cur.dirs.includes(root) ? cur.dirs : [...cur.dirs, root];
  ix.projects = {
    ...ix.projects,
    [marker.id]: { name: marker.name, dirs, lastSeen: new Date().toISOString() },
  };
  writeIndex(ix);
}

/** Every project this device has seen, with its display name. */
export function knownProjects(): { id: string; name: string; dirs: string[] }[] {
  return Object.entries(readIndex().projects).map(([id, p]) => ({
    id,
    name: p.name,
    dirs: p.dirs,
  }));
}

/** Folders on this device known to hold project `id`, still present on disk. */
export function dirsForProject(id: string): string[] {
  return (readIndex().projects[id]?.dirs ?? []).filter((d) => existsSync(d));
}

/** The project id governing `dir`, if it has a valid marker. No side effects. */
export function projectIdForDir(dir: string): string | undefined {
  if (!dir || !existsSync(dir)) return undefined;
  const r = findProjectMarker(dir);
  return r.kind === 'found' ? r.marker.id : undefined;
}

/**
 * Ids this device sees in two places that are not the same repo — a copied
 * folder or a fork that carried the marker along. Worktrees of one repo share
 * a main checkout and are not reported. The user decides which one to detach.
 */
export function duplicateProjectIds(): { id: string; dirs: string[] }[] {
  const out: { id: string; dirs: string[] }[] = [];
  for (const [id, p] of Object.entries(readIndex().projects)) {
    const live = p.dirs.filter((d) => existsSync(d) && projectIdForDir(d) === id);
    const repos = new Set(live.map((d) => mainCheckout(d) ?? d));
    if (repos.size > 1) out.push({ id, dirs: live });
  }
  return out;
}
