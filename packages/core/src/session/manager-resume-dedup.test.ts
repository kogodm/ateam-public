import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** node-pty mocked: this suite is about how many PTYs a repeated resume
 *  spawns, and CI can't boot real claude processes. */
let spawnCount = 0;
vi.mock('node-pty', () => ({
  spawn: () => {
    spawnCount++;
    let onExit: ((e: { exitCode: number }) => void) | undefined;
    return {
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => {
        onExit = cb;
        return { dispose: () => {} };
      },
      write: () => {},
      resize: () => {},
      // a real PTY delivers the exit event when killed — the tombstone
      // test needs the session to actually reach 'exited'
      kill: () => onExit?.({ exitCode: 0 }),
      pid: 1234,
    };
  },
}));

const { SessionManager } = await import('./manager');

describe('resume dedup', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-resume-dedup-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    spawnCount = 0;
  });

  const resumeArgs = (id: string) => ({
    projectName: 'proj-d',
    agentName: 'ann',
    role: 'coder',
    workspace: { id: 'ws-d', name: 'proj-d', root: home },
    resumeSessionId: id,
  });

  it('a second resume of a LIVE conversation returns it instead of double-spawning', () => {
    const m = new SessionManager();
    const id = '11111111-2222-4333-8444-555555555555';
    const first = m.spawn(resumeArgs(id));
    expect(spawnCount).toBe(1);
    // desktop's dialog AND the phone's dialog both said "restore" —
    // the second ask must land on the same session, not fork a twin.
    const second = m.spawn(resumeArgs(id));
    expect(second.sessionId).toBe(first.sessionId);
    expect(spawnCount).toBe(1);
  });

  it('an EXITED tombstone does not count as live — resume respawns it', () => {
    const m = new SessionManager();
    const id = '66666666-7777-4888-9999-aaaaaaaaaaaa';
    const first = m.spawn(resumeArgs(id));
    m.kill(first.sessionId);
    const second = m.spawn(resumeArgs(id));
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(spawnCount).toBe(2);
  });

  it('a fresh spawn (no resumeSessionId) never dedups', () => {
    const m = new SessionManager();
    const args = {
      projectName: 'proj-d',
      agentName: 'ann',
      role: 'coder',
      workspace: { id: 'ws-d', name: 'proj-d', root: home },
    };
    const a = m.spawn(args);
    const b = m.spawn(args);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(spawnCount).toBe(2);
  });
});
