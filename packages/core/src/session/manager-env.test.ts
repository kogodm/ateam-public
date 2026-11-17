import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** node-pty is mocked so we can read the environment a session would be born
 *  with; a real claude PTY can't be spawned in CI. */
const spawned: { env: Record<string, string> }[] = [];
vi.mock('node-pty', () => ({
  spawn: (_bin: string, _args: string[], opts: { env: Record<string, string> }) => {
    spawned.push({ env: opts.env });
    return {
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
      pid: 4242,
    };
  },
}));

/** The login shell is a CHILD of this process, so in the real leak it echoes
 *  back every marker claude exported. Reproduce that here — this is the half
 *  that made the first fix ineffective. */
vi.mock('../platform', async (orig) => ({
  ...(await orig<typeof import('../platform')>()),
  loginShellEnv: () => ({
    PATH: '/opt/homebrew/bin:/usr/bin',
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'parent-session',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock',
    CLAUDE_CODE_MESSAGING_TOKEN: 'parent-token',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
  }),
  mergedPath: () => '/opt/homebrew/bin:/usr/bin',
}));

const { SessionManager } = await import('./manager');

describe('a spawned session never inherits the parent claude', () => {
  let home: string;
  let prevHome: string | undefined;
  const planted = [
    'CLAUDECODE',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_PID',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'AI_AGENT',
  ];

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-env-spec-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
    // the app itself started from inside a claude session
    for (const k of planted) process.env[k] = 'inherited';
  });

  afterAll(() => {
    // biome-ignore lint/performance/noDelete: must be ABSENT — assigning undefined leaves the string "undefined"
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    // biome-ignore lint/performance/noDelete: same — must be absent, not "undefined"
    for (const k of planted) delete process.env[k];
    rmSync(home, { recursive: true, force: true });
  });

  it('strips every marker, from process.env AND from the login shell', () => {
    const m = new SessionManager();
    m.spawn({
      projectName: 'proj-env',
      agentName: 'ann',
      role: 'coder',
      workspace: { id: 'ws-env', name: 'proj-env', root: home },
    });
    const env = spawned[0]?.env ?? {};
    for (const k of planted) expect(`${k}=${env[k] ?? '(absent)'}`).toBe(`${k}=(absent)`);
    m.shutdown();
  });

  it('still passes on what the session needs to work', () => {
    const env = spawned[0]?.env ?? {};
    // the login shell's own exports (third-party endpoints, PATH) must survive
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.invalid');
    expect(env.PATH).toContain('/opt/homebrew/bin');
    // and the app's per-PTY tags
    expect(env.ATEAM_SESSION).toBeTruthy();
    expect(env.ATEAM_HOME).toBe(home);
  });
});
