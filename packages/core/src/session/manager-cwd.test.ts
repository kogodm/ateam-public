import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionManager } from './manager';

/**
 * A workspace directory that has been moved or deleted since Ateam last saw it
 * (a repo reorganised under a still-remembered path) used to reach node-pty,
 * whose child then failed to chdir and died with exit 1 and NO output — an
 * empty terminal and a tombstone that explained nothing.
 */
describe('spawning into a directory that is gone', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-cwd-spec-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  const spawnInto = (m: SessionManager, root: string) =>
    m.spawn({
      projectName: 'gone',
      agentName: 'ann',
      role: 'coder',
      workspace: { id: 'ws-gone', name: 'gone', root },
    });

  it('fails at the call, naming the directory and the nearest survivor', () => {
    const m = new SessionManager();
    const missing = join(home, 'projects', 'repo', 'Sub');
    try {
      spawnInto(m, missing);
      throw new Error('expected spawn to throw');
    } catch (e) {
      const err = e as Error & { code?: string };
      expect(err.code).toBe('cwd_missing');
      expect(err.message).toContain(missing);
      expect(err.message).toContain(home); // the nearest existing ancestor
    }
    // and it left no half-built session behind
    expect(m.list().flatMap((p) => p.sessions)).toHaveLength(0);
    m.shutdown();
  });

  it('says nothing about a directory that does exist', () => {
    const m = new SessionManager();
    // no PTY is spawned in this suite's environment check — we only assert the
    // guard does not fire for a live directory
    expect(() => {
      try {
        spawnInto(m, home);
      } catch (e) {
        if ((e as { code?: string }).code === 'cwd_missing') throw e;
        /* any other failure (no claude binary here) is not this guard's business */
      }
    }).not.toThrow();
    m.shutdown();
  });
});
