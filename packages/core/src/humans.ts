import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ateamHome } from './paths';

/**
 * A Human is the long-term asset (a virtual person), not a role. The role is
 * an attribute (the hat they wear). Knowledge/skills/experiences are keyed by
 * the human's id. Each human records the project dirs they've participated in.
 */
export interface HumanProject {
  dir: string;
  /** stable, readable project key — the per-project vault dir name
   *  (`projects/<key>/…`). Unique within a human; survives across runs. */
  key: string;
  /** human-readable project name (defaults to the dir's basename) */
  name: string;
  firstSeen: string;
  lastSeen: string;
  /** the project's portable id (`.ateam/project.json`) when the dir has one —
   *  what another device matches this participation on; `dir` is only where
   *  it lives on this machine */
  projectId?: string;
}
export interface Human {
  id: string;
  name: string;
  role: string;
  provider?: string;
  /** What this teammate is responsible for, in their own words — injected
   *  into every session they run so the role is a real scope, not a label.
   *  Absent on humans created before this existed: those sessions get the
   *  name+role line alone, which is what they had in chat mode already. */
  duties?: string;
  /** The model this teammate works on, as the runtime's own flag takes it
   *  (`claude --model` / `codex -m`): an alias like 'opus' or 'sonnet', or a
   *  full id like 'claude-fable-5-1'. Absent = the runtime's own default
   *  (what the user's CLI settings say). Applies to every session this human
   *  runs, chat mode and the normal tree alike. */
  model?: string;
  notes?: string;
  avatarId?: string;
  experienceSummary?: { text: string; at: string };
  createdAt: string;
  projects: HumanProject[];
  /** Projects this human worked on on OTHER devices (from sync) that this
   *  device has no folder for. Kept so a sync push carries them back instead
   *  of erasing them; becomes a normal `projects[]` entry once the folder is
   *  linked here. */
  remoteProjects?: RemoteProject[];
}

export interface RemoteProject {
  projectId: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
}

function humansFile(): string {
  return join(ateamHome(), 'humans.json');
}

function sanitizeKey(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project'
  );
}

/**
 * Migration + invariant: every project entry gets a stable, readable,
 * unique `key`/`name`. Legacy humans.json only had {dir,firstSeen,lastSeen};
 * this backfills them deterministically. Pure (mutates in place); returns
 * whether anything changed so the caller can decide to persist.
 */
function normalizeProjects(h: Human): boolean {
  if (!Array.isArray(h.projects)) {
    h.projects = [];
    return false;
  }
  let changed = false;
  const used = new Set(h.projects.map((p) => p.key).filter(Boolean));
  for (const p of h.projects) {
    if (!p.name) {
      p.name = basename(p.dir.replace(/\/+$/, '')) || 'project';
      changed = true;
    }
    if (!p.key) {
      const base = sanitizeKey(p.name);
      let k = base;
      let n = 2;
      while (used.has(k)) k = `${base}-${n++}`;
      p.key = k;
      used.add(k);
      changed = true;
    }
  }
  return changed;
}

/**
 * Parsed humans.json, reused until the file changes.
 *
 * `session.list()` calls getHuman() once PER SESSION to live-pull the current
 * name/role, so building a 58-row tree re-read, re-parsed and re-migrated the
 * same 18KB file 58 times — and the tree is rebuilt once per restored session
 * plus every 5s. Keyed on mtime+size like the transcript memos; writes through
 * this module drop it explicitly, since a rename that lands in the same
 * millisecond and keeps the same length would otherwise slip past both guards.
 */
let humansCache: { mtimeMs: number; size: number; humans: Human[] } | undefined;

export function listHumans(): Human[] {
  try {
    const file = humansFile();
    const st = statSync(file);
    if (humansCache && humansCache.mtimeMs === st.mtimeMs && humansCache.size === st.size) {
      return humansCache.humans;
    }
    const j = JSON.parse(readFileSync(file, 'utf8')) as { humans?: Human[] };
    const humans = j.humans ?? [];
    for (const h of humans) normalizeProjects(h); // read-path migration (in memory)
    humansCache = { mtimeMs: st.mtimeMs, size: st.size, humans };
    return humans;
  } catch {
    return [];
  }
}

/** Bake the readable-project-index migration to disk (idempotent). Call once
 *  at startup so legacy humans.json upgrades even without a new spawn. */
export function migrateHumans(): void {
  if (!existsSync(humansFile())) return;
  const humans = listHumans(); // normalized in memory
  if (humans.length > 0) saveAll(humans);
}

function saveAll(humans: Human[]): void {
  mkdirSync(ateamHome(), { recursive: true });
  writeFileSync(humansFile(), JSON.stringify({ humans }, null, 2));
  // The callers here mutate the objects they got from listHumans() and then
  // save, so what is in memory IS the new truth — but stat-based guards cannot
  // be trusted for a write we just made ourselves (same millisecond, and a
  // rename can keep the byte count). Drop the memo and let the next read
  // rebuild it.
  humansCache = undefined;
}

export function getHuman(id: string): Human | undefined {
  return listHumans().find((h) => h.id === id);
}

/** Find by id, else by (name,role) — create if absent. Stable id is the key. */
export function ensureHuman(input: {
  id?: string;
  name: string;
  role: string;
  provider?: string;
  model?: string;
}): Human {
  const humans = listHumans();
  let h = input.id
    ? humans.find((x) => x.id === input.id)
    : humans.find((x) => x.name === input.name && x.role === input.role);
  if (h) return h;
  h = {
    id: randomUUID(),
    name: input.name,
    role: input.role,
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    createdAt: new Date().toISOString(),
    projects: [],
  };
  humans.push(h);
  saveAll(humans);
  return h;
}

/** Insert or replace a whole human record (sync applies remote humans with
 *  this; the caller has already merged what must stay device-local). */
export function upsertHuman(next: Human): void {
  const humans = listHumans();
  const i = humans.findIndex((x) => x.id === next.id);
  const copy = { ...next, projects: next.projects.map((p) => ({ ...p })) };
  normalizeProjects(copy);
  if (i === -1) humans.push(copy);
  else humans[i] = copy;
  saveAll(humans);
}

/** Record that this human participated in a project directory. */
export function recordHumanProject(id: string, dir: string, projectId?: string): void {
  const humans = listHumans();
  const h = humans.find((x) => x.id === id);
  if (!h) return;
  const now = new Date().toISOString();
  const p = h.projects.find((x) => x.dir === dir);
  if (p) {
    p.lastSeen = now;
    if (projectId) p.projectId = projectId;
  } else {
    h.projects.push({
      dir,
      key: '',
      name: '',
      firstSeen: now,
      lastSeen: now,
      ...(projectId ? { projectId } : {}),
    });
  }
  normalizeProjects(h); // assign a stable readable key/name to the new entry
  saveAll(humans);
}

/**
 * The readable project key for a dir (the `projects/<key>/` vault scope).
 * Read-only: resolves the persisted key when the dir is already recorded
 * (recordHumanProject runs at spawn before recall), else a deterministic
 * fallback so adoption and recall agree even pre-registration.
 */
export function projectKeyForDir(humanId: string, dir: string): string {
  const p = getHuman(humanId)?.projects.find((x) => x.dir === dir);
  if (p?.key) return p.key;
  return sanitizeKey(basename(dir.replace(/\/+$/, '')) || 'project');
}

export function updateHuman(
  id: string,
  patch: Partial<
    Pick<Human, 'name' | 'notes' | 'provider' | 'role' | 'avatarId' | 'model' | 'duties'>
  >,
): Human | undefined {
  const humans = listHumans();
  const h = humans.find((x) => x.id === id);
  if (!h) return undefined;
  // sanitize: name/role must be non-empty if provided (zod already enforces
  // at the boundary, but defend so direct callers can't leave a blank).
  const next = { ...h };
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (n) next.name = n;
  }
  if (patch.role !== undefined) {
    const r = patch.role.trim();
    if (r) next.role = r;
  }
  if (patch.provider !== undefined) next.provider = patch.provider || undefined;
  if (patch.notes !== undefined) next.notes = patch.notes || undefined;
  if (patch.avatarId !== undefined) next.avatarId = patch.avatarId || undefined;
  // '' clears the binding — back to whatever the runtime defaults to
  if (patch.model !== undefined) next.model = patch.model.trim() || undefined;
  if (patch.duties !== undefined) next.duties = patch.duties.trim() || undefined;
  const i = humans.findIndex((x) => x.id === id);
  humans[i] = next;
  saveAll(humans);
  return next;
}

/** Persist a natural-language experience summary on the Human (immutable copy,
 *  mirrors updateHuman's read-modify-saveAll). Returns the updated Human, or
 *  undefined if no such human. */
export function setHumanSummary(
  id: string,
  summary: { text: string; at: string },
): Human | undefined {
  const humans = listHumans();
  const i = humans.findIndex((x) => x.id === id);
  if (i === -1) return undefined;
  const next = { ...humans[i], experienceSummary: summary } as Human;
  humans[i] = next;
  saveAll(humans);
  return next;
}

/**
 * A stable, writable cwd for a directory-less session ("talk to the human,
 * no project"). The agent starts here and uses Bash `cd` to navigate into
 * real projects on its own, guided by its skills/recall. Kept out of
 * `projects[]` so it never pollutes the human's participation history.
 */
export function humanDeskDir(humanId: string): string {
  const dir = join(ateamHome(), 'humans', humanId, 'desk');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function humansFilePath(): string {
  return humansFile();
}
export function humansExist(): boolean {
  return existsSync(humansFile());
}
