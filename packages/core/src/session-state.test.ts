import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadFocusedClaudeSessionId,
  loadSessionState,
  type SavedAgent,
  saveSessionState,
  sessionStatePath,
} from './session-state';

// tui-state.json lives under ateamHome() (ATEAM_HOME) — isolate per test.
let home: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.ATEAM_HOME;
  home = mkdtempSync(join(tmpdir(), 'ateam-state-'));
  process.env.ATEAM_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.ATEAM_HOME;
  else process.env.ATEAM_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

const agent = (id: string): SavedAgent => ({
  projectName: 'p',
  agentName: 'a',
  role: 'coder',
  dir: '/tmp/p',
  claudeSessionId: id,
});

describe('session-state', () => {
  it('round-trips agents + focused id', () => {
    saveSessionState([agent('one'), agent('two')], 'one');
    expect(loadSessionState().map((a) => a.claudeSessionId)).toEqual(['one', 'two']);
    expect(loadFocusedClaudeSessionId()).toBe('one');
  });

  it('preserves the previous focused id when the caller omits it', () => {
    saveSessionState([agent('one')], 'one');
    saveSessionState([agent('one'), agent('two')]);
    expect(loadFocusedClaudeSessionId()).toBe('one');
  });

  it('writes atomically — no leftover .tmp file, and the real file exists', () => {
    saveSessionState([agent('one')], 'one');
    expect(existsSync(sessionStatePath())).toBe(true);
    const leftover = readdirSync(home).filter((f) => f.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });

  it('an empty/missing file loads as an empty list, not a throw', () => {
    expect(loadSessionState()).toEqual([]);
    expect(loadFocusedClaudeSessionId()).toBeUndefined();
  });
});
