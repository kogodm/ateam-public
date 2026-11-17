import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { humanMetaDir } from '../human-meta';
import { type Human, listHumans, upsertHuman } from '../humans';
import { ateamHome } from '../paths';
import { findProjectMarker, knownProjects } from '../project-identity';
import { dirsForProject } from '../project-identity';
import { listPrompts, resetPromptOverride, setPromptOverride } from '../prompts';
import { type Task, allTasks, removeTask, upsertTask } from '../tasks';
import { sha256 } from './crypto';

/**
 * The local side of sync: what this device has, as records, and how a record
 * from another device is written back. Record shapes: docs/sync/client.md.
 */

export type SyncType = 'human' | 'project' | 'task' | 'file' | 'prompt';
export const SYNC_TYPES: readonly SyncType[] = ['project', 'human', 'task', 'file', 'prompt'];

export interface LocalRecord {
  type: SyncType;
  localId: string;
  payload: Record<string, unknown>;
  /** sha256 of the canonical payload */
  hash: string;
  /** ms; 0 = unknown (the caller uses "now") */
  updatedAt: number;
  /** file records: the content */
  content?: Buffer;
}

export const lk = (type: string, localId: string): string => `${type}:${localId}`;

/** JSON with sorted keys and no undefined — equal data, equal hash */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;

function rec(
  type: SyncType,
  localId: string,
  payload: Record<string, unknown>,
  updatedAt = 0,
  content?: Buffer,
): LocalRecord {
  return { type, localId, payload, hash: sha256(canonical(payload)), updatedAt, content };
}

/* ── humans ─────────────────────────────────────────────────────────────── */

function humanPayload(h: Human): Record<string, unknown> {
  const byId = new Map<
    string,
    { projectId: string; name: string; firstSeen: string; lastSeen: string }
  >();
  const add = (p: {
    projectId?: string;
    name: string;
    firstSeen: string;
    lastSeen: string;
  }): void => {
    if (!p.projectId) return;
    const cur = byId.get(p.projectId);
    byId.set(p.projectId, {
      projectId: p.projectId,
      name: cur?.name ?? p.name,
      firstSeen: cur && cur.firstSeen < p.firstSeen ? cur.firstSeen : p.firstSeen,
      lastSeen: cur && cur.lastSeen > p.lastSeen ? cur.lastSeen : p.lastSeen,
    });
  };
  for (const p of h.projects) add(p);
  for (const p of h.remoteProjects ?? []) add(p);
  return {
    id: h.id,
    name: h.name,
    role: h.role,
    provider: h.provider,
    duties: h.duties,
    model: h.model,
    notes: h.notes,
    avatarId: h.avatarId,
    experienceSummary: h.experienceSummary,
    createdAt: h.createdAt,
    projects: [...byId.values()].sort((a, b) => a.projectId.localeCompare(b.projectId)),
  };
}

function applyHuman(p: Record<string, unknown>): void {
  const id = String(p.id ?? '');
  if (!id) return;
  const local = listHumans().find((h) => h.id === id);
  const remote = (Array.isArray(p.projects) ? p.projects : []) as {
    projectId: string;
    name: string;
    firstSeen: string;
    lastSeen: string;
  }[];
  const projects = (local?.projects ?? []).map((lp) => {
    const r = remote.find((x) => x.projectId && x.projectId === lp.projectId);
    if (!r) return lp;
    return {
      ...lp,
      firstSeen: r.firstSeen < lp.firstSeen ? r.firstSeen : lp.firstSeen,
      lastSeen: r.lastSeen > lp.lastSeen ? r.lastSeen : lp.lastSeen,
    };
  });
  const localIds = new Set(projects.map((x) => x.projectId).filter(Boolean));
  const remoteProjects = remote.filter((r) => r.projectId && !localIds.has(r.projectId));
  const opt = (k: string): string | undefined =>
    typeof p[k] === 'string' && p[k] ? (p[k] as string) : undefined;
  upsertHuman({
    id,
    name: opt('name') ?? local?.name ?? 'teammate',
    role: opt('role') ?? local?.role ?? 'coder',
    provider: opt('provider'),
    duties: opt('duties'),
    model: opt('model'),
    notes: opt('notes'),
    avatarId: opt('avatarId'),
    experienceSummary: (p.experienceSummary as Human['experienceSummary']) ?? undefined,
    createdAt: opt('createdAt') ?? local?.createdAt ?? new Date().toISOString(),
    projects,
    ...(remoteProjects.length ? { remoteProjects } : {}),
  });
}

/* ── projects ───────────────────────────────────────────────────────────── */

const syncedProjectsPath = (): string => join(ateamHome(), 'sync', 'projects.json');
type ProjectInfo = { id: string; name: string; createdAt: string };

function readSyncedProjects(): Record<string, ProjectInfo> {
  try {
    return JSON.parse(readFileSync(syncedProjectsPath(), 'utf8')) as Record<string, ProjectInfo>;
  } catch {
    return {};
  }
}
function writeSyncedProjects(v: Record<string, ProjectInfo>): void {
  mkdirSync(dirname(syncedProjectsPath()), { recursive: true, mode: 0o700 });
  atomicWrite(syncedProjectsPath(), JSON.stringify(v, null, 2));
}

/** projects the account has (from any device) — what "link a folder" offers */
export function accountProjects(): ProjectInfo[] {
  const merged = new Map(Object.entries(readSyncedProjects()));
  for (const p of knownProjects()) {
    const dir = p.dirs.find((d) => existsSync(d));
    const m = dir ? findProjectMarker(dir) : undefined;
    const createdAt =
      m?.kind === 'found' ? m.marker.createdAt : (merged.get(p.id)?.createdAt ?? '');
    merged.set(p.id, { id: p.id, name: p.name, createdAt });
  }
  return [...merged.values()];
}

/* ── tasks ──────────────────────────────────────────────────────────────── */

function taskPayload(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    status: t.status,
    projectId: t.projectId ?? '',
    remindAt: t.remindAt,
    reminded: t.reminded,
    tags: t.tags,
    source: t.source,
    createdAt: t.createdAt,
    doneAt: t.doneAt,
  };
}

function applyTask(p: Record<string, unknown>): void {
  const id = String(p.id ?? '');
  if (!id || typeof p.title !== 'string') return;
  const local = allTasks().find((t) => t.id === id);
  const projectId = typeof p.projectId === 'string' ? p.projectId : '';
  const project =
    projectId && local?.projectId === projectId
      ? local.project
      : projectId
        ? (dirsForProject(projectId)[0] ?? '')
        : (local?.project ?? '');
  upsertTask({
    id,
    title: p.title,
    body: typeof p.body === 'string' ? p.body : undefined,
    status: p.status === 'done' ? 'done' : 'open',
    project,
    ...(projectId ? { projectId } : {}),
    remindAt: typeof p.remindAt === 'number' ? p.remindAt : undefined,
    reminded: p.reminded === true ? true : undefined,
    tags: Array.isArray(p.tags) ? (p.tags as string[]) : undefined,
    source: p.source === 'agent' ? 'agent' : 'user',
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
    doneAt: typeof p.doneAt === 'number' ? p.doneAt : undefined,
    // which session raised it only means something on the device it ran on
    sessionId: local?.sessionId,
    claudeSessionId: local?.claudeSessionId,
  });
}

/* ── human meta files ───────────────────────────────────────────────────── */

/** per-path content cache keyed on mtime+size — a pass re-reads only what changed */
const fileCache = new Map<string, { mtimeMs: number; size: number; content: Buffer }>();

function walk(root: string, dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (n.startsWith('.') || n.endsWith('.tmp')) continue;
    const abs = join(dir, n);
    const st = lstatSync(abs);
    // symlinks point at device-local installs (market skills) — never synced
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(root, abs, out);
    else if (st.isFile() && st.size <= MAX_FILE_BYTES)
      out.push(relative(root, abs).split(sep).join('/'));
  }
}

/** a path from another device, confined to the meta dir */
export function safeMetaPath(path: string): string | undefined {
  if (!path || path.startsWith('/') || path.includes('\\')) return undefined;
  const parts = path.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..' || x.startsWith('.'))) return undefined;
  return path;
}

function fileRecords(humanIds: string[], blobIdOf: (b: Buffer) => string): LocalRecord[] {
  const out: LocalRecord[] = [];
  for (const humanId of humanIds) {
    const root = humanMetaDir(humanId);
    if (!existsSync(root)) continue;
    const paths: string[] = [];
    walk(root, root, paths);
    for (const path of paths) {
      const abs = join(root, path);
      const st = lstatSync(abs);
      let c = fileCache.get(abs);
      if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
        c = { mtimeMs: st.mtimeMs, size: st.size, content: readFileSync(abs) };
        fileCache.set(abs, c);
      }
      out.push(
        rec(
          'file',
          `${humanId}/${path}`,
          { humanId, path, blob: blobIdOf(c.content), size: c.content.length },
          Math.floor(st.mtimeMs),
          c.content,
        ),
      );
    }
  }
  return out;
}

function metaFileAbs(localId: string): string | undefined {
  const slash = localId.indexOf('/');
  const humanId = localId.slice(0, slash);
  const path = safeMetaPath(localId.slice(slash + 1));
  if (slash <= 0 || !path || !/^[A-Za-z0-9-]+$/.test(humanId)) return undefined;
  return join(humanMetaDir(humanId), path);
}

function atomicWrite(path: string, body: string | Buffer): void {
  const tmp = `${path}.${process.pid}.sync.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

export function writeMetaFile(localId: string, content: Buffer, mtimeMs: number): void {
  const abs = metaFileAbs(localId);
  if (!abs) throw new Error(`refusing unsafe synced path ${localId}`);
  mkdirSync(dirname(abs), { recursive: true });
  atomicWrite(abs, content);
  if (mtimeMs > 0) utimesSync(abs, new Date(), new Date(mtimeMs));
}

/** `notes.md` → `notes.conflict-<device>-<yyyymmddHHMM>.md`, beside it */
export function conflictCopyId(localId: string, device: string, at = new Date()): string {
  const slash = localId.lastIndexOf('/');
  const dir = localId.slice(0, slash + 1);
  const name = localId.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}${p(at.getHours())}${p(at.getMinutes())}`;
  const dev = device.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 24) || 'device';
  return `${dir}${stem}.conflict-${dev}-${stamp}${ext}`;
}

/* ── the snapshot and the writer ────────────────────────────────────────── */

export function collectLocal(blobIdOf: (b: Buffer) => string): Map<string, LocalRecord> {
  const out = new Map<string, LocalRecord>();
  const put = (r: LocalRecord): void => {
    out.set(lk(r.type, r.localId), r);
  };
  for (const p of accountProjects()) put(rec('project', p.id, { ...p }));
  const humans = listHumans();
  for (const h of humans) put(rec('human', h.id, humanPayload(h)));
  for (const t of allTasks()) put(rec('task', t.id, taskPayload(t), t.doneAt ?? 0));
  for (const r of fileRecords(
    humans.map((h) => h.id),
    blobIdOf,
  ))
    put(r);
  for (const p of listPrompts())
    if (p.customized) put(rec('prompt', p.name, { name: p.name, text: p.text }));
  return out;
}

/** Write a record from another device. `content` for files. */
export function applyRemote(
  type: string,
  localId: string,
  payload: Record<string, unknown>,
  updatedAt: number,
  content?: Buffer,
): void {
  switch (type) {
    case 'human':
      applyHuman(payload);
      return;
    case 'task':
      applyTask(payload);
      return;
    case 'project': {
      const id = String(payload.id ?? '');
      if (!id) return;
      writeSyncedProjects({
        ...readSyncedProjects(),
        [id]: { id, name: String(payload.name ?? id), createdAt: String(payload.createdAt ?? '') },
      });
      return;
    }
    case 'file':
      if (content) writeMetaFile(localId, content, updatedAt);
      return;
    case 'prompt':
      if (typeof payload.text === 'string') setPromptOverride(localId, payload.text);
      return;
    default:
      return;
  }
}

/** A tombstone from another device. Humans are never deleted by sync — losing
 *  a teammate's identity to a stray delete is not recoverable. */
export function removeLocal(type: string, localId: string): void {
  switch (type) {
    case 'task':
      removeTask(localId);
      return;
    case 'project': {
      const { [localId]: _gone, ...rest } = readSyncedProjects();
      writeSyncedProjects(rest);
      return;
    }
    case 'file': {
      const abs = metaFileAbs(localId);
      if (abs) rmSync(abs, { force: true });
      return;
    }
    case 'prompt':
      try {
        resetPromptOverride(localId);
      } catch {
        /* not an editable prompt on this version */
      }
      return;
    default:
      return;
  }
}
