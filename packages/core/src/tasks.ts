import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ateamHome } from './paths';
import { projectIdForDir } from './project-identity';

/**
 * Task list + future reminders. A flat JSON store at `~/.ateam/tasks.json`,
 * shared by TWO writers: the desktop (via rpc-server) and the per-session
 * `ateam-tasks` MCP server child that agents talk to. Cross-process sync is
 * a plain `fs.watch` on the file (rpc-server → `task.changed` event).
 *
 * The list surface only ever shows `title` (kept short); `body` carries the
 * paths/context the agent stashed and is delivered to a session ONLY on the
 * user's one-click send — never rendered.
 */
export interface Task {
  id: string;
  /** the portable id of `project` (its `.ateam/project.json`), when it has
   *  one — how the task finds its project on another device, where `project`
   *  (an absolute dir) means nothing */
  projectId?: string;
  /** brief — the only thing the task list renders */
  title: string;
  /** carried context (paths / snippet). Hidden in the list; sent to the
   *  session on one-click. */
  body?: string;
  status: 'open' | 'done';
  /** absolute project dir this task belongs to (a session cwd). '' = unscoped,
   *  shown only in the "all tasks" view. */
  project: string;
  /** epoch ms; when set and reached, a one-shot reminder fires. */
  remindAt?: number;
  /** set once the reminder has fired so it never re-fires. */
  reminded?: boolean;
  /** up to 3 short labels (project / priority / task-type / …). Rendered as
   *  colored chips; the color is derived deterministically from the text. */
  tags?: string[];
  source: 'agent' | 'user';
  /** the session that created it, when known (agent side). NOTE: this is
   *  ATeam's transient in-memory sessionId — gone after a restart. */
  sessionId?: string;
  /** the CREATING session's claude session id at add time (stable across
   *  restarts — it names the transcript on disk). This is what the desktop's
   *  "jump to the originating session" uses; `sessionId` above can't. */
  claudeSessionId?: string;
  createdAt: number;
  doneAt?: number;
}

/** Trim, drop blanks, de-dupe (case-insensitive), cap length, keep at most 3. */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().slice(0, 24);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}

function tasksFile(): string {
  return join(ateamHome(), 'tasks.json');
}

/** Absolute path of the store — the rpc-server watches this for cross-process
 *  changes (the MCP child writes it too). */
export function tasksFilePath(): string {
  return tasksFile();
}

function readAll(): Task[] {
  try {
    const j = JSON.parse(readFileSync(tasksFile(), 'utf8')) as { tasks?: Task[] };
    return Array.isArray(j.tasks) ? j.tasks : [];
  } catch {
    return []; // missing / malformed → empty list
  }
}

/** Atomic write (temp + rename) so a concurrent reader never sees a torn
 *  file. The temp name carries the pid so the two writers don't collide. */
function writeAll(tasks: Task[]): void {
  const file = tasksFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tasks }, null, 2));
  renameSync(tmp, file);
}

/** Open tasks first, then soonest reminder, then newest. */
function order(a: Task, b: Task): number {
  if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
  const ar = a.remindAt ?? Number.POSITIVE_INFINITY;
  const br = b.remindAt ?? Number.POSITIVE_INFINITY;
  if (ar !== br) return ar - br;
  return b.createdAt - a.createdAt;
}

/** Every task, unfiltered and unsorted — what sync reads. */
export function allTasks(): Task[] {
  return readAll();
}

/** Insert or replace a task by id (sync applies remote tasks with this). */
export function upsertTask(task: Task): void {
  const tasks = readAll();
  const i = tasks.findIndex((t) => t.id === task.id);
  if (i === -1) tasks.push(task);
  else tasks[i] = task;
  writeAll(tasks);
}

export function listTasks(filter?: { project?: string; status?: Task['status'] }): Task[] {
  let tasks = readAll();
  if (filter?.project !== undefined) tasks = tasks.filter((t) => t.project === filter.project);
  if (filter?.status) tasks = tasks.filter((t) => t.status === filter.status);
  return tasks.sort(order);
}

export function addTask(input: {
  title: string;
  body?: string;
  project?: string;
  remindAt?: number;
  tags?: string[];
  source?: Task['source'];
  sessionId?: string;
  claudeSessionId?: string;
}): Task {
  const tags = normalizeTags(input.tags);
  const task: Task = {
    id: randomUUID(),
    title: input.title.trim().slice(0, 200) || '(untitled)',
    body: input.body?.trim() || undefined,
    status: 'open',
    project: input.project ?? '',
    ...(input.project ? withProjectId(input.project) : {}),
    remindAt: input.remindAt && input.remindAt > 0 ? input.remindAt : undefined,
    tags: tags.length ? tags : undefined,
    source: input.source ?? 'user',
    sessionId: input.sessionId,
    claudeSessionId: input.claudeSessionId,
    createdAt: Date.now(),
  };
  const tasks = readAll();
  tasks.push(task);
  writeAll(tasks);
  return task;
}

function withProjectId(project: string): { projectId?: string } {
  try {
    const projectId = projectIdForDir(project);
    return projectId ? { projectId } : {};
  } catch {
    return {}; // identity is best-effort; a task is still a task without it
  }
}

/** Give tasks created before project ids existed the id of their project, where
 *  that project now has one. Idempotent; returns how many it filled in. */
export function backfillTaskProjectIds(): number {
  const tasks = readAll();
  let n = 0;
  // one lookup per project, not per task: each costs a couple of git calls,
  // and a long task list shares a handful of projects
  const byDir = new Map<string, { projectId?: string }>();
  const next = tasks.map((t) => {
    if (t.projectId || !t.project) return t;
    let add = byDir.get(t.project);
    if (!add) {
      add = withProjectId(t.project);
      byDir.set(t.project, add);
    }
    if (!add.projectId) return t;
    n++;
    return { ...t, ...add };
  });
  if (n > 0) writeAll(next);
  return n;
}

export function completeTask(id: string): Task | null {
  const tasks = readAll();
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  t.status = 'done';
  t.doneAt = Date.now();
  writeAll(tasks);
  return t;
}

/** Reopen a done task (uncheck). */
export function reopenTask(id: string): Task | null {
  const tasks = readAll();
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  t.status = 'open';
  t.doneAt = undefined;
  writeAll(tasks);
  return t;
}

export function removeTask(id: string): boolean {
  const tasks = readAll();
  const next = tasks.filter((x) => x.id !== id);
  if (next.length === tasks.length) return false;
  writeAll(next);
  return true;
}

/** Patch an existing task. Only provided fields change. `tags` REPLACES the
 *  set (normalized, capped at 3); `remindAt` null/0 clears the reminder. A
 *  new/changed remindAt clears the one-shot `reminded` flag so it fires again.
 *  Returns the updated task, or null if the id is unknown. */
export function updateTask(
  id: string,
  patch: {
    title?: string;
    body?: string;
    remindAt?: number | null;
    tags?: string[];
    status?: 'open' | 'done';
  },
): Task | null {
  const tasks = readAll();
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  if (patch.title !== undefined) {
    const title = patch.title.trim().slice(0, 200);
    if (title) t.title = title;
  }
  if (patch.body !== undefined) t.body = patch.body.trim() || undefined;
  if (patch.remindAt !== undefined) {
    const ms = patch.remindAt;
    t.remindAt = ms && ms > 0 ? ms : undefined;
    t.reminded = undefined; // re-arm the one-shot reminder
  }
  if (patch.tags !== undefined) {
    const n = normalizeTags(patch.tags);
    t.tags = n.length ? n : undefined;
  }
  if (patch.status !== undefined) {
    t.status = patch.status;
    t.doneAt = patch.status === 'done' ? Date.now() : undefined;
  }
  writeAll(tasks);
  return t;
}

/** Append tags to a task (existing first), de-duped and capped at 3. */
export function addTags(id: string, tags: string[]): Task | null {
  const tasks = readAll();
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  const merged = normalizeTags([...(t.tags ?? []), ...tags]);
  t.tags = merged.length ? merged : undefined;
  writeAll(tasks);
  return t;
}

/**
 * Mark due, still-open, not-yet-reminded tasks as reminded and return exactly
 * those that JUST fired. One-shot per task, idempotent across calls — the
 * sidecar scheduler polls this and broadcasts a `task.due` per returned task.
 */
export function claimDueReminders(now = Date.now()): Task[] {
  const tasks = readAll();
  const fired = tasks.filter(
    (t) => t.status === 'open' && t.remindAt && !t.reminded && t.remindAt <= now,
  );
  if (fired.length) {
    for (const t of fired) t.reminded = true;
    writeAll(tasks);
  }
  return fired;
}
