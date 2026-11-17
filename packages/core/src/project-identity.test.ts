import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dirsForProject,
  duplicateProjectIds,
  ensureProjectMarker,
  findProjectMarker,
  isProjectId,
  linkProjectMarker,
  newProjectId,
  projectIdForDir,
  recordProjectDir,
} from './project-identity';

const git = (dir: string, ...args: string[]): void => {
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    stdio: 'ignore',
  });
};
const markerAt = (root: string) => join(root, '.ateam', 'project.json');

describe('project identity', () => {
  let base: string;
  let prevHome: string | undefined;
  let prevAteam: string | undefined;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ateam-projid-'));
    prevHome = process.env.HOME;
    prevAteam = process.env.ATEAM_HOME;
    // a fake home, so "never write into home" is testable without touching the real one
    process.env.HOME = join(base, 'home');
    mkdirSync(process.env.HOME, { recursive: true });
    process.env.ATEAM_HOME = join(base, 'home', '.ateam');
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    if (prevAteam === undefined) Reflect.deleteProperty(process.env, 'ATEAM_HOME');
    else process.env.ATEAM_HOME = prevAteam;
    rmSync(base, { recursive: true, force: true });
  });

  it('creates a marker once, then finds the same id — also from a subfolder', () => {
    const proj = join(base, 'plain');
    mkdirSync(join(proj, 'src', 'deep'), { recursive: true });
    const made = ensureProjectMarker(proj);
    expect(made.kind).toBe('created');
    if (made.kind !== 'created') return;
    expect(isProjectId(made.marker.id)).toBe(true);
    expect(made.marker.name).toBe('plain');
    expect(ensureProjectMarker(proj)).toMatchObject({
      kind: 'found',
      marker: { id: made.marker.id },
    });
    // a subfolder belongs to the project above it — no second marker
    expect(projectIdForDir(join(proj, 'src', 'deep'))).toBe(made.marker.id);
    expect(existsSync(markerAt(join(proj, 'src', 'deep')))).toBe(false);
  });

  it('puts a git project marker at the checkout top, whatever subfolder asked', () => {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'packages', 'a'), { recursive: true });
    git(repo, 'init', '-q');
    const r = ensureProjectMarker(join(repo, 'packages', 'a'));
    expect(r.kind).toBe('created');
    expect(existsSync(markerAt(repo))).toBe(true);
    expect(existsSync(markerAt(join(repo, 'packages', 'a')))).toBe(false);
  });

  it('a worktree without its own marker is the same project as its main checkout', () => {
    const repo = join(base, 'wt-main');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'README'), 'x');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    const main = ensureProjectMarker(repo);
    if (main.kind !== 'created') throw new Error('expected created');
    const wt = join(base, 'wt-feature');
    git(repo, 'worktree', 'add', '-q', wt);
    expect(projectIdForDir(wt)).toBe(main.marker.id);
    expect(ensureProjectMarker(wt)).toMatchObject({
      kind: 'found',
      marker: { id: main.marker.id },
    });
  });

  it('never overwrites a marker it cannot read — it may be committed', () => {
    const proj = join(base, 'broken');
    mkdirSync(join(proj, '.ateam'), { recursive: true });
    writeFileSync(markerAt(proj), '{ not json');
    expect(ensureProjectMarker(proj).kind).toBe('invalid');
    expect(readFileSync(markerAt(proj), 'utf8')).toBe('{ not json');
    expect(projectIdForDir(proj)).toBeUndefined();
  });

  it("refuses home — a marker there would sit inside Ateam's own .ateam", () => {
    expect(ensureProjectMarker(process.env.HOME as string).kind).toBe('refused');
    expect(existsSync(markerAt(process.env.HOME as string))).toBe(false);
  });

  it('links a folder to an existing project, but does not silently re-id one', () => {
    const a = join(base, 'device-b-copy');
    mkdirSync(a, { recursive: true });
    const id = newProjectId();
    expect(linkProjectMarker(a, { id, name: 'TrixMahjong', createdAt: '' }).kind).toBe('created');
    expect(projectIdForDir(a)).toBe(id);
    const other = newProjectId();
    expect(linkProjectMarker(a, { id: other, name: 'x', createdAt: '' }).kind).toBe('refused');
    expect(
      linkProjectMarker(a, { id: other, name: 'x', createdAt: '' }, { replace: true }).kind,
    ).toBe('created');
    expect(projectIdForDir(a)).toBe(other);
  });

  it('indexes where each project lives on this device', () => {
    const proj = join(base, 'indexed');
    mkdirSync(proj, { recursive: true });
    const r = ensureProjectMarker(proj);
    if (r.kind !== 'created') throw new Error('expected created');
    recordProjectDir(r.marker, r.root);
    recordProjectDir(r.marker, r.root); // idempotent
    expect(dirsForProject(r.marker.id)).toEqual([r.root]);
  });

  it('reports one id claimed by two unrelated folders, not by two worktrees', () => {
    const a = join(base, 'original');
    mkdirSync(a, { recursive: true });
    const r = ensureProjectMarker(a);
    if (r.kind !== 'created') throw new Error('expected created');
    const copy = join(base, 'copied');
    cpSync(a, copy, { recursive: true }); // a copied folder carries the marker along
    recordProjectDir(r.marker, r.root);
    recordProjectDir(r.marker, copy);
    expect(duplicateProjectIds()).toEqual([{ id: r.marker.id, dirs: [r.root, copy] }]);
  });
});

describe('what carries the project id', () => {
  let base: string;
  let prevHome: string | undefined;
  let prevAteam: string | undefined;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ateam-projid-carry-'));
    prevHome = process.env.HOME;
    prevAteam = process.env.ATEAM_HOME;
    process.env.HOME = join(base, 'home');
    mkdirSync(process.env.HOME, { recursive: true });
    process.env.ATEAM_HOME = join(base, 'home', '.ateam');
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    if (prevAteam === undefined) Reflect.deleteProperty(process.env, 'ATEAM_HOME');
    else process.env.ATEAM_HOME = prevAteam;
    rmSync(base, { recursive: true, force: true });
  });

  it('a task added in a project with a marker records the id; one without does not', async () => {
    const { addTask, backfillTaskProjectIds, listTasks } = await import('./tasks');
    const proj = join(base, 'with-marker');
    const bare = join(base, 'no-marker');
    mkdirSync(proj, { recursive: true });
    mkdirSync(bare, { recursive: true });
    const early = addTask({ title: 'filed before the marker', project: proj });
    expect(early.projectId).toBeUndefined();
    const r = ensureProjectMarker(proj);
    if (r.kind !== 'created') throw new Error('expected created');
    expect(addTask({ title: 'filed after', project: proj }).projectId).toBe(r.marker.id);
    expect(addTask({ title: 'elsewhere', project: bare }).projectId).toBeUndefined();
    // the early one catches up
    expect(backfillTaskProjectIds()).toBe(1);
    expect(listTasks({}).find((t) => t.id === early.id)?.projectId).toBe(r.marker.id);
    expect(backfillTaskProjectIds()).toBe(0); // idempotent
  });

  it("a human's project participation records the id beside the local dir", async () => {
    const { ensureHuman, getHuman, recordHumanProject } = await import('./humans');
    const h = ensureHuman({ name: 'Weber', role: 'coder' });
    const id = newProjectId();
    recordHumanProject(h.id, '/somewhere/TrixMahjong', id);
    expect(getHuman(h.id)?.projects[0]).toMatchObject({
      dir: '/somewhere/TrixMahjong',
      projectId: id,
    });
  });
});
