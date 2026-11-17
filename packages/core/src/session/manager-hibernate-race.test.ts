import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionManager } from './manager';

/** hibernate() kills the PTY on purpose; the PTY's async onExit (SIGHUP,
 *  code 129) used to flip the node back to 'exited' a tick later — the
 *  hibernated row turned into a dead tombstone that never woke. */
describe('hibernate vs late PTY exit', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevBin: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-hib-race-'));
    prevHome = process.env.ATEAM_HOME;
    prevBin = process.env.ATEAM_CLAUDE_BIN;
    process.env.ATEAM_HOME = home;
    // a stand-in "claude" that just idles, whatever flags it gets
    const bin = join(home, 'fake-claude.sh');
    writeFileSync(bin, '#!/bin/sh\nsleep 30\n');
    chmodSync(bin, 0o755);
    process.env.ATEAM_CLAUDE_BIN = bin;
  });
  afterAll(() => {
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    if (prevBin === undefined) delete process.env.ATEAM_CLAUDE_BIN;
    else process.env.ATEAM_CLAUDE_BIN = prevBin;
    rmSync(home, { recursive: true, force: true });
  });

  it('stays hibernated after the killed PTY reports its exit', async () => {
    const m = new SessionManager();
    const states: string[] = [];
    m.on('status', (d: { state: string }) => states.push(d.state));
    const node = m.spawn({
      agentName: 'dack',
      role: 'coder',
      workspace: { id: 'ws-test', name: 'test', root: home },
    });
    expect(node.state).toBe('running');
    m.hibernate(node.sessionId);
    await new Promise((r) => setTimeout(r, 400)); // let the SIGHUP exit land
    const after = m
      .list()
      .flatMap((p) => p.sessions)
      .find((s) => s.sessionId === node.sessionId);
    expect(after?.state).toBe('hibernated');
    expect(states).not.toContain('exited');
    m.shutdown();
  });
});
