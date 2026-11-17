import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureHuman,
  getHuman,
  humansFilePath,
  listHumans,
  migrateHumans,
  projectKeyForDir,
  recordHumanProject,
  setHumanSummary,
  updateHuman,
} from './humans';

describe('Human registry', () => {
  const prev = process.env.ATEAM_HOME;
  afterEach(() => {
    if (prev === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prev;
  });

  it('REGRESSION: a rename is visible immediately, memo or not', () => {
    // listHumans() is memoised because session.list() calls getHuman() once
    // per session — 58 re-reads of the same 18KB file to build one tree. The
    // memo must never outlive a write: renaming a teammate updates every tab
    // without respawning anything, and that is the whole point of the live
    // pull in list().
    process.env.ATEAM_HOME = mkdtempSync(join(tmpdir(), 'ateam-hum-memo-'));
    const a = ensureHuman({ name: 'before', role: 'coder' });
    expect(getHuman(a.id)?.name).toBe('before'); // warms the memo

    updateHuman(a.id, { name: 'after' });
    expect(getHuman(a.id)?.name).toBe('after');

    // a second writer path (project recording) must not resurrect stale names
    recordHumanProject(a.id, '/tmp/some-project');
    expect(getHuman(a.id)?.name).toBe('after');
    expect(getHuman(a.id)?.projects.some((p) => p.dir === '/tmp/some-project')).toBe(true);
  });

  it('picks up an edit made outside this process', () => {
    // humans.json is a plain file in the user's home; someone repairing a
    // stale project path by hand must not be served the memo forever
    process.env.ATEAM_HOME = mkdtempSync(join(tmpdir(), 'ateam-hum-ext-'));
    const a = ensureHuman({ name: 'edited-outside', role: 'coder' });
    expect(listHumans()).toHaveLength(1);

    const file = humansFilePath();
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { humans: { name: string }[] };
    const first = raw.humans[0];
    if (first) first.name = 'changed on disk';
    writeFileSync(file, JSON.stringify(raw, null, 2));

    expect(getHuman(a.id)?.name).toBe('changed on disk');
  });

  it('creates, dedups by (name,role), records projects', () => {
    process.env.ATEAM_HOME = mkdtempSync(join(tmpdir(), 'ateam-hum-'));

    const a = ensureHuman({ name: '小明', role: 'coder' });
    const b = ensureHuman({ name: '小明', role: 'coder' }); // same human reused
    expect(b.id).toBe(a.id);
    const c = ensureHuman({ name: '小明', role: 'reviewer' }); // different hat = different human
    expect(c.id).not.toBe(a.id);
    expect(listHumans()).toHaveLength(2);

    // one human, multiple project participations
    recordHumanProject(a.id, '/p/web');
    recordHumanProject(a.id, '/p/api');
    recordHumanProject(a.id, '/p/web'); // dedup, updates lastSeen
    const h = getHuman(a.id);
    expect(h?.projects.map((p) => p.dir).sort()).toEqual(['/p/api', '/p/web']);

    // by-id reuse
    expect(ensureHuman({ id: a.id, name: 'ignored', role: 'ignored' }).id).toBe(a.id);
  });

  it('assigns stable, readable, unique project keys/names', () => {
    process.env.ATEAM_HOME = mkdtempSync(join(tmpdir(), 'ateam-hum-'));
    const a = ensureHuman({ name: 'k', role: 'coder' });
    recordHumanProject(a.id, '/work/badminton_server_lambda');
    recordHumanProject(a.id, '/other/badminton_server_lambda'); // same basename

    const ps = getHuman(a.id)?.projects ?? [];
    expect(ps.map((p) => p.name)).toEqual(['badminton_server_lambda', 'badminton_server_lambda']);
    const keys = ps.map((p) => p.key);
    expect(keys[0]).toBe('badminton-server-lambda'); // readable, sanitized
    expect(keys[1]).toBe('badminton-server-lambda-2'); // collision → suffixed
    expect(new Set(keys).size).toBe(2); // unique within the human
    // resolver is read-only & stable
    expect(projectKeyForDir(a.id, '/work/badminton_server_lambda')).toBe('badminton-server-lambda');
  });

  it('round-trips avatarId via updateHuman and persists experienceSummary', () => {
    process.env.ATEAM_HOME = mkdtempSync(join(tmpdir(), 'ateam-hum-'));
    const a = ensureHuman({ name: 'avi', role: 'coder' });

    updateHuman(a.id, { avatarId: 'avatar-7' });
    expect(getHuman(a.id)?.avatarId).toBe('avatar-7');
    // empty string clears it
    updateHuman(a.id, { avatarId: '' });
    expect(getHuman(a.id)?.avatarId).toBeUndefined();

    const s = setHumanSummary(a.id, { text: 'a sharp backend engineer', at: '2026-06-05T00:00:00.000Z' });
    expect(s?.experienceSummary?.text).toBe('a sharp backend engineer');
    // re-read from disk
    expect(getHuman(a.id)?.experienceSummary?.text).toBe('a sharp backend engineer');
    expect(getHuman(a.id)?.experienceSummary?.at).toBe('2026-06-05T00:00:00.000Z');

    // unknown id is a no-op (undefined)
    expect(setHumanSummary('nope', { text: 'x', at: 'y' })).toBeUndefined();
  });

  it('migrates legacy humans.json that lacks key/name (compat)', () => {
    process.env.ATEAM_HOME = mkdtempSync(join(tmpdir(), 'ateam-hum-'));
    const f = humansFilePath();
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(
      f,
      JSON.stringify({
        humans: [
          {
            id: 'legacy-1',
            name: 'old',
            role: 'coder',
            createdAt: '2026-01-01T00:00:00.000Z',
            projects: [{ dir: '/srv/App', firstSeen: 'x', lastSeen: 'y' }],
          },
        ],
      }),
    );
    migrateHumans();
    const p = getHuman('legacy-1')?.projects[0];
    expect(p?.name).toBe('App');
    expect(p?.key).toBe('app');
  });
});
