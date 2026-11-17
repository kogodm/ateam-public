import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** node-pty mocked: we only care what CLI args a resume is launched with. */
let spawnedArgs: string[][] = [];
vi.mock('node-pty', () => ({
  spawn: (_file: string, args: string[]) => {
    spawnedArgs.push(args);
    return {
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
      pid: 4321,
    };
  },
}));

const { SessionManager } = await import('./manager');
const { upsertHandoffRecord, getHandoffRecord } = await import('./handoff-state');

describe('resuming a session whose handoff was interrupted', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevUserHome: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-handoff-resume-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
    // spawn() only resumes when claude's transcript for the id exists under
    // ~/.claude/projects — point HOME at the sandbox and write one per test
    prevUserHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterAll(() => {
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    if (prevUserHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevUserHome;
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    spawnedArgs = [];
  });

  /** a transcript on disk for `id`, so the resume is a real `--resume` */
  const writeTranscript = (id: string): void => {
    const dir = join(home, '.claude', 'projects', home.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.jsonl`),
      '{"type":"user","message":{"role":"user","content":"hi"}}\n',
    );
  };

  const resumeArgs = (id: string) => ({
    projectName: 'proj',
    agentName: 'ann',
    role: 'coder',
    workspace: { id: 'ws', name: 'proj', root: home },
    resumeSessionId: id,
  });

  it('pending (prompt injected, no doc yet): the handoff prompt becomes the first message and the handoff is in flight', () => {
    const old = 'aaaaaaaa-0000-4000-8000-000000000001';
    writeTranscript(old);
    upsertHandoffRecord({
      oldClaudeSessionId: old,
      handoffPath: '',
      status: 'pending',
      triggeredAt: new Date().toISOString(),
    });
    const m = new SessionManager();
    const node = m.spawn(resumeArgs(old));
    const args = spawnedArgs[0] ?? [];
    expect(args).toContain('--resume');
    const prompt = args[args.indexOf('--') + 1] ?? '';
    expect(prompt).toContain('handoff');
    expect(prompt).toContain('cut short by an app restart');
    expect(m.isHandingOff(node.sessionId)).toBe(true);
    // the record is re-stamped as pending for this run
    expect(getHandoffRecord(old)?.status).toBe('pending');
  });

  it('doc_ready with the doc on disk: no prompt is re-sent, the successor is spawned from the doc', () => {
    vi.useFakeTimers();
    try {
      const old = 'aaaaaaaa-0000-4000-8000-000000000002';
      writeTranscript(old);
      const doc = join(home, 'handoff-2.md');
      writeFileSync(doc, '# handoff\ncontinue the refactor');
      upsertHandoffRecord({
        oldClaudeSessionId: old,
        handoffPath: doc,
        status: 'doc_ready',
        triggeredAt: new Date().toISOString(),
      });
      const m = new SessionManager();
      const node = m.spawn(resumeArgs(old));
      expect(spawnedArgs).toHaveLength(1);
      expect(spawnedArgs[0]).not.toContain('--');
      expect(m.isHandingOff(node.sessionId)).toBe(true);
      vi.advanceTimersByTime(2000);
      // second PTY = the successor, launched fresh with the doc as its first message
      expect(spawnedArgs).toHaveLength(2);
      const succ = spawnedArgs[1] ?? [];
      expect(succ).toContain('--session-id');
      expect(succ[succ.indexOf('--') + 1] ?? '').toContain('continue the refactor');
      expect(getHandoffRecord(old)?.status).toBe('taken_over');
      expect(m.get(node.sessionId)?.replacedBySessionId).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stale record (older than the window) is ignored', () => {
    const old = 'aaaaaaaa-0000-4000-8000-000000000003';
    writeTranscript(old);
    upsertHandoffRecord({
      oldClaudeSessionId: old,
      handoffPath: '',
      status: 'pending',
      triggeredAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    });
    const m = new SessionManager();
    const node = m.spawn(resumeArgs(old));
    expect(spawnedArgs[0]).not.toContain('--');
    expect(m.isHandingOff(node.sessionId)).toBe(false);
  });
});
