import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ptys: { args: string[]; killed: boolean; writes: string[] }[] = [];
vi.mock('node-pty', () => ({
  spawn: (_file: string, args: string[]) => {
    const rec = { args, killed: false, writes: [] as string[] };
    ptys.push(rec);
    return {
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: (data: string) => rec.writes.push(data),
      resize: () => {},
      kill: () => {
        rec.killed = true;
      },
      pid: 4321,
    };
  },
}));

const { SessionManager } = await import('./manager');
const { transcriptPath } = await import('./transcript-file');
const { storeTitle } = await import('./provider-store');

describe('switching provider without using the old model', () => {
  let home: string;
  let prevAteamHome: string | undefined;
  let prevHome: string | undefined;
  let prevCodexHome: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-switch-provider-'));
    prevAteamHome = process.env.ATEAM_HOME;
    prevHome = process.env.HOME;
    prevCodexHome = process.env.CODEX_HOME;
    process.env.ATEAM_HOME = join(home, 'ateam');
    process.env.HOME = home;
    process.env.CODEX_HOME = join(home, '.codex');
  });
  beforeEach(() => {
    ptys.length = 0;
  });
  afterAll(() => {
    if (prevAteamHome === undefined) Reflect.deleteProperty(process.env, 'ATEAM_HOME');
    else process.env.ATEAM_HOME = prevAteamHome;
    if (prevHome === undefined) Reflect.deleteProperty(process.env, 'HOME');
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) Reflect.deleteProperty(process.env, 'CODEX_HOME');
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('exports the transcript, starts the target runtime, retires the source and emits replacement', () => {
    const manager = new SessionManager();
    const source = manager.spawn({
      projectName: 'project',
      agentName: 'Weber',
      role: 'coder',
      workspace: { id: 'ws', name: 'project', root: home },
      providerId: 'claude',
    });
    const path = transcriptPath(home, source.claudeSessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'continue this task' } }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'implemented half' }] },
        }),
      ].join('\n'),
    );
    let replaced: { oldSessionId: string; newSessionId: string } | undefined;
    manager.on('replaced', (event) => {
      replaced = event as { oldSessionId: string; newSessionId: string };
    });

    const result = manager.switchProvider(source.sessionId, 'codex');
    expect(readFileSync(result.contextPath, 'utf8')).toContain('continue this task');
    expect(readFileSync(result.contextPath, 'utf8')).toContain('implemented half');
    expect(ptys).toHaveLength(2);
    expect(ptys[0]?.killed).toBe(true);
    expect(ptys[0]?.writes).toEqual([]);
    expect(ptys[1]?.args).toContain('resume');
    expect(ptys[1]?.args).toContain(result.session.claudeSessionId);
    expect(ptys[1]?.args.at(-1)).toContain('native session history');
    expect(manager.get(source.sessionId)?.replacedBySessionId).toBe(result.session.sessionId);
    expect(replaced).toMatchObject({
      oldSessionId: source.sessionId,
      newSessionId: result.session.sessionId,
    });
    const returned = manager.switchProvider(result.session.sessionId, 'claude');
    expect(ptys).toHaveLength(3);
    expect(ptys[1]?.writes).toEqual([]);
    expect(ptys[1]?.killed).toBe(true);
    expect(ptys[2]?.args).toContain('--resume');
    expect(ptys[2]?.args).toContain(returned.session.claudeSessionId);
    const returnedHistory = readFileSync(returned.contextPath, 'utf8');
    expect(returnedHistory).toContain('continue this task');
    expect(returnedHistory).toContain('implemented half');
    expect(returnedHistory).not.toContain('Read that file now');
    expect(readFileSync(path, 'utf8')).not.toContain('native session history');
    manager.shutdown();
  });

  it('leaves the source running when there is no migratable history', () => {
    const manager = new SessionManager();
    const source = manager.spawn({
      projectName: 'project',
      agentName: 'Weber',
      role: 'coder',
      workspace: { id: 'ws', name: 'project', root: home },
      providerId: 'claude',
    });
    expect(() => manager.switchProvider(source.sessionId, 'codex')).toThrow();
    expect(ptys).toHaveLength(1);
    expect(ptys[0]?.killed).toBe(false);
    expect(manager.get(source.sessionId)?.replacedBySessionId).toBeUndefined();
    manager.shutdown();
  });

  it('persists the current display name across native switches, listing, restore and explicit rename', () => {
    const manager = new SessionManager();
    try {
      const source = manager.spawn({
        projectName: 'project',
        agentName: 'Weber',
        role: 'coder',
        workspace: { id: 'ws', name: 'project', root: home },
        providerId: 'claude',
      });
      const path = transcriptPath(home, source.claudeSessionId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        `${[
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fixture task' } }),
          JSON.stringify({
            type: 'custom-title',
            customTitle: 'Original session name',
            sessionId: source.claudeSessionId,
          }),
        ].join('\n')}\n`,
      );
      const switched = manager.switchProvider(source.sessionId, 'codex').session;
      expect(switched.sessionName).toBe('Original session name');
      expect(storeTitle('codex', home, switched.claudeSessionId)).toBe('Original session name');
      const listedName = () =>
        manager
          .list()
          .flatMap((project) => project.sessions)
          .find((session) => session.sessionId === switched.sessionId)?.sessionName;
      expect(listedName()).toBe('Original session name');
      const restored = new SessionManager();
      try {
        restored.addHibernated({
          projectName: 'project',
          agentName: 'Weber',
          role: 'coder',
          dir: home,
          claudeSessionId: switched.claudeSessionId,
          providerId: 'codex',
        });
        expect(restored.list().flatMap((project) => project.sessions)[0]?.sessionName).toBe(
          'Original session name',
        );
      } finally {
        restored.shutdown();
      }
      const returned = manager.switchProvider(switched.sessionId, 'claude').session;
      expect(storeTitle('claude', home, returned.claudeSessionId)).toBe('Original session name');
      const switchedAgain = manager.switchProvider(returned.sessionId, 'codex').session;
      expect(storeTitle('codex', home, switchedAgain.claudeSessionId)).toBe(
        'Original session name',
      );
      appendFileSync(
        join(process.env.CODEX_HOME as string, 'session_index.jsonl'),
        `${JSON.stringify({ id: switchedAgain.claudeSessionId, thread_name: 'User renamed', updated_at: new Date().toISOString() })}\n`,
      );
      expect(storeTitle('codex', home, switchedAgain.claudeSessionId)).toBe('User renamed');
      expect(
        manager
          .list()
          .flatMap((project) => project.sessions)
          .find((session) => session.sessionId === switchedAgain.sessionId)?.sessionName,
      ).toBe('User renamed');
      expect(storeTitle('claude', home, source.claudeSessionId)).toBe('Original session name');
    } finally {
      manager.shutdown();
    }
  });
});
