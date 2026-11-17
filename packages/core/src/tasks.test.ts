import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addTask,
  claimDueReminders,
  completeTask,
  listTasks,
  removeTask,
  reopenTask,
  updateTask,
  addTags,
} from './tasks';

describe('task store', () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-tasks-spec-'));
    prev = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it('adds tasks and keeps body off the title surface', () => {
    addTask({ title: 'first', project: '/p1' });
    const t2 = addTask({ title: 'second', body: 'do X in a/b.ts', project: '/p1' });
    const list = listTasks({ project: '/p1' });
    expect(list.map((t) => t.title).sort()).toEqual(['first', 'second']);
    const stored = list.find((t) => t.id === t2.id);
    expect(stored?.body).toBe('do X in a/b.ts'); // body persisted, list renderer just ignores it
  });

  it('scopes by project', () => {
    addTask({ title: 'a', project: '/p1' });
    addTask({ title: 'b', project: '/p2' });
    expect(listTasks({ project: '/p1' }).map((t) => t.title)).toEqual(['a']);
    expect(listTasks().length).toBe(2); // no filter → all projects
  });

  it('completes, reopens, and orders done tasks after open ones', () => {
    const a = addTask({ title: 'a', project: '/p' });
    addTask({ title: 'b', project: '/p' });
    expect(completeTask(a.id)?.status).toBe('done');
    expect(listTasks({ project: '/p' }).map((t) => t.status)).toEqual(['open', 'done']);
    expect(reopenTask(a.id)?.status).toBe('open');
    expect(listTasks({ project: '/p', status: 'open' }).length).toBe(2);
  });

  it('stores tags: trims, de-dupes case-insensitively, caps at 3', () => {
    const t = addTask({
      title: 'tagged',
      project: '/p',
      tags: [' bug ', 'Bug', 'P0', '', 'feature', 'extra'],
    });
    expect(t.tags).toEqual(['bug', 'P0', 'feature']); // 'Bug' dropped, blank dropped, capped to 3
  });

  it('omits tags when none are given', () => {
    expect(addTask({ title: 'x', project: '/p' }).tags).toBeUndefined();
  });

  it('updateTask patches only given fields; tags replace, remindAt re-arms', () => {
    const t = addTask({ title: 'a', body: 'old', project: '/p', tags: ['x'] });
    const u = updateTask(t.id, { body: 'new', tags: ['y', 'z'] });
    expect(u?.body).toBe('new');
    expect(u?.title).toBe('a'); // untouched
    expect(u?.tags).toEqual(['y', 'z']); // replaced, not merged
    // completing then reopening via status
    expect(updateTask(t.id, { status: 'done' })?.status).toBe('done');
    expect(updateTask(t.id, { status: 'open' })?.doneAt).toBeUndefined();
    expect(updateTask('nope', { title: 'x' })).toBeNull();
  });

  it('addTags appends, de-dupes, caps at 3', () => {
    const t = addTask({ title: 'a', project: '/p', tags: ['x', 'y'] });
    expect(addTags(t.id, ['Y', 'z', 'w'])?.tags).toEqual(['x', 'y', 'z']); // Y dup, w over cap
    expect(addTags('nope', ['a'])).toBeNull();
  });

  it('removes a task', () => {
    const a = addTask({ title: 'gone', project: '/p' });
    expect(removeTask(a.id)).toBe(true);
    expect(removeTask(a.id)).toBe(false);
    expect(listTasks().length).toBe(0);
  });

  it('claims due reminders exactly once', () => {
    const past = Date.now() - 1000;
    const future = Date.now() + 60_000;
    const due = addTask({ title: 'due', project: '/p', remindAt: past });
    addTask({ title: 'later', project: '/p', remindAt: future });
    addTask({ title: 'no-remind', project: '/p' });

    const fired = claimDueReminders();
    expect(fired.map((t) => t.id)).toEqual([due.id]);
    // idempotent — a second sweep fires nothing new
    expect(claimDueReminders()).toEqual([]);
  });

  it('does not fire a reminder for a completed task', () => {
    const t = addTask({ title: 'done-before-due', project: '/p', remindAt: Date.now() - 1000 });
    completeTask(t.id);
    expect(claimDueReminders()).toEqual([]);
  });
});
