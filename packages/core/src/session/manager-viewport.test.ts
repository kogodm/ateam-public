import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** node-pty is mocked: this suite is about the SIZE a PTY is asked for, and a
 *  real claude PTY can't be spawned in CI (and would boot an agent). Each fake
 *  records the {cols,rows} it was born with. */
const spawned: { cols: number; rows: number; resized: [number, number][] }[] = [];
vi.mock('node-pty', () => ({
  spawn: (_bin: string, _args: string[], opts: { cols: number; rows: number }) => {
    const rec = { cols: opts.cols, rows: opts.rows, resized: [] as [number, number][] };
    spawned.push(rec);
    return {
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: (c: number, r: number) => rec.resized.push([c, r]),
      kill: () => {},
      pid: 1234,
    };
  },
}));

const { SessionManager } = await import('./manager');

describe('PTY viewport sizing', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-viewport-spec-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    spawned.length = 0;
  });

  const spawnOne = (m: InstanceType<typeof SessionManager>, name: string) =>
    m.spawn({
      projectName: 'proj-v',
      agentName: name,
      role: 'coder',
      workspace: { id: 'ws-v', name: 'proj-v', root: home },
    });

  it('starts a new PTY at the size a pane last reported, not the 120×32 fallback', () => {
    const m = new SessionManager();
    const first = spawnOne(m, 'ann');
    // the pane mounts and fits: this is the first real size we ever learn
    m.resize(first.sessionId, 197, 44);

    const second = spawnOne(m, 'bo');
    expect(spawned[1]).toMatchObject({ cols: 197, rows: 44 });
    expect(second.sessionId).not.toBe(first.sessionId);
    m.shutdown();
  });

  it('wakes a hibernated session at the width it was last drawn at', () => {
    const m = new SessionManager();
    const s = spawnOne(m, 'cy');
    m.resize(s.sessionId, 210, 50);
    m.hibernate(s.sessionId);
    // another client reports a different size before the wake
    const other = spawnOne(m, 'dee');
    m.resize(other.sessionId, 100, 20);

    m.wake(s.sessionId);
    // the woken session keeps ITS size (210×50), not the 100×20 house default
    expect(spawned.at(-1)).toMatchObject({ cols: 210, rows: 50 });
    m.shutdown();
  });

  it('announces every real size change — a client whose terminal is hidden cannot measure itself', () => {
    const m = new SessionManager();
    const s = spawnOne(m, 'gus');
    const seen: unknown[] = [];
    m.on('resize', (d) => seen.push(d));

    m.resize(s.sessionId, 197, 44);
    expect(seen).toEqual([{ sessionId: s.sessionId, cols: 197, rows: 44 }]);
    expect(m.sizeOf(s.sessionId)).toEqual({ cols: 197, rows: 44 });

    // Re-reporting the size it already has is not a change. Every announcement
    // makes the other side re-lay its emulator out, and every PTY resize costs
    // a claude redraw — a client that reports on each mount/tab switch would
    // otherwise churn both for nothing.
    m.resize(s.sessionId, 197, 44);
    expect(seen).toHaveLength(1);

    m.resize(s.sessionId, 0, 0); // hidden pane: not a size at all
    expect(seen).toHaveLength(1);
    m.shutdown();
  });

  it('ignores the 0×0 a hidden pane reports, so it cannot poison the default', () => {
    const m = new SessionManager();
    const s = spawnOne(m, 'eli');
    m.resize(s.sessionId, 180, 40);
    m.resize(s.sessionId, 0, 0); // pane hidden (display:none)

    expect(spawned[0]?.resized).toEqual([[180, 40]]);
    const next = spawnOne(m, 'fay');
    expect(spawned.at(-1)).toMatchObject({ cols: 180, rows: 40 });
    expect(next.sessionId).toBeTruthy();
    m.shutdown();
  });
});
