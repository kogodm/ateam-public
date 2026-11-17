import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearLiveSessionCache,
  isRunningAsBackgroundAgent,
  liveClaudeSessions,
} from './claude-live';

/**
 * Claude Code 2.1 refuses `--resume` for a conversation already open as a
 * background agent. Ateam resumes on restore and on wake, so it has to know
 * before it spawns — the registry under ~/.claude/sessions is how.
 */
describe('live claude sessions', () => {
  let home: string;
  let prev: string | undefined;

  const record = (pid: number, body: Record<string, unknown>): void =>
    writeFileSync(join(home, 'sessions', `${pid}.json`), JSON.stringify(body));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-live-spec-'));
    mkdirSync(join(home, 'sessions'));
    prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    clearLiveSessionCache();
  });

  afterEach(() => {
    if (prev === undefined) {
      // biome-ignore lint/performance/noDelete: unsetting an env var is the point
      delete process.env.CLAUDE_CONFIG_DIR;
    } else process.env.CLAUDE_CONFIG_DIR = prev;
    clearLiveSessionCache();
    rmSync(home, { recursive: true, force: true });
  });

  it('reports a background agent that is really running', () => {
    record(process.pid, { sessionId: 'sess-bg', pid: process.pid, kind: 'bg' });
    expect(isRunningAsBackgroundAgent('sess-bg')).toBe(true);
  });

  it('leaves an interactive session alone — the CLI still resumes those', () => {
    record(process.pid, { sessionId: 'sess-i', pid: process.pid, kind: 'interactive' });
    expect(liveClaudeSessions().get('sess-i')).toBe('interactive');
    expect(isRunningAsBackgroundAgent('sess-i')).toBe(false);
  });

  it('ignores a record whose process is gone', () => {
    // the registry keeps a file behind when a process dies without cleaning up;
    // trusting it would fork a session for no reason
    record(999_999, { sessionId: 'sess-dead', pid: 999_999, kind: 'bg' });
    expect(isRunningAsBackgroundAgent('sess-dead')).toBe(false);
  });

  it('survives half-written and foreign files', () => {
    writeFileSync(join(home, 'sessions', 'torn.json'), '{"sessionId": ');
    writeFileSync(join(home, 'sessions', '123.key'), 'not json at all');
    record(process.pid, { sessionId: 'sess-ok', pid: process.pid, kind: 'bg' });
    expect(isRunningAsBackgroundAgent('sess-ok')).toBe(true);
  });

  it('is empty when there is no registry at all (older CLI)', () => {
    rmSync(join(home, 'sessions'), { recursive: true, force: true });
    clearLiveSessionCache();
    expect(liveClaudeSessions().size).toBe(0);
    expect(isRunningAsBackgroundAgent('anything')).toBe(false);
  });

  it('says no for an id nobody is running', () => {
    record(process.pid, { sessionId: 'sess-bg', pid: process.pid, kind: 'bg' });
    expect(isRunningAsBackgroundAgent('some-other-id')).toBe(false);
    expect(isRunningAsBackgroundAgent('')).toBe(false);
  });
});
