import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionManager } from './manager';

describe('session hibernation (no PTY)', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-hibernate-spec-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('addHibernated registers a tree node without booting claude', () => {
    const m = new SessionManager();
    const node = m.addHibernated({
      projectName: 'proj-x',
      agentName: 'dack',
      role: 'coder',
      dir: '/tmp/proj-x',
      claudeSessionId: 'cccccccc-0000-0000-0000-000000000000',
    });
    expect(node.state).toBe('hibernated');
    expect(node.claudeSessionId).toBe('cccccccc-0000-0000-0000-000000000000');
    const tree = m.list();
    expect(tree.flatMap((p) => p.sessions).map((s) => s.sessionId)).toContain(node.sessionId);
    // input to a hibernated session is a safe no-op (no PTY to write to)
    expect(() => m.input(node.sessionId, 'hello')).not.toThrow();
    // hibernating an already-hibernated session is a no-op too
    expect(() => m.hibernate(node.sessionId)).not.toThrow();
    m.shutdown();
  });

  it('groups hibernated sessions under an existing project name', () => {
    const m = new SessionManager();
    const a = m.addHibernated({
      projectName: 'proj-y',
      agentName: 'kasa',
      role: 'coder',
      dir: '/tmp/proj-y',
      claudeSessionId: 'dddddddd-0000-0000-0000-000000000001',
    });
    const b = m.addHibernated({
      projectName: 'proj-y',
      agentName: 'mira',
      role: 'ui',
      dir: '/tmp/proj-y',
      claudeSessionId: 'dddddddd-0000-0000-0000-000000000002',
    });
    expect(a.projectId).toBe(b.projectId);
    m.shutdown();
  });
});
