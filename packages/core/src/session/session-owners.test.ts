import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSessionOwner, getSessionOwners, recordSessionOwner } from './session-owners';

// The owners index lives under ateamHome() (ATEAM_HOME) — isolate per test.
let home: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.ATEAM_HOME;
  home = mkdtempSync(join(tmpdir(), 'ateam-owners-'));
  process.env.ATEAM_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.ATEAM_HOME;
  else process.env.ATEAM_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe('session-owners', () => {
  it('round-trips a single record', () => {
    expect(getSessionOwner('claude-1')).toBeUndefined();
    recordSessionOwner('claude-1', 'human-a');
    expect(getSessionOwner('claude-1')).toBe('human-a');
  });

  it('overwrites on re-record (e.g. a later /clear rotation)', () => {
    recordSessionOwner('claude-1', 'human-a');
    recordSessionOwner('claude-1', 'human-b');
    expect(getSessionOwner('claude-1')).toBe('human-b');
  });

  it('batch-looks-up only the ids that have an owner', () => {
    recordSessionOwner('claude-1', 'human-a');
    recordSessionOwner('claude-2', 'human-b');
    expect(getSessionOwners(['claude-1', 'claude-2', 'claude-unknown'])).toEqual({
      'claude-1': 'human-a',
      'claude-2': 'human-b',
    });
  });

  it('ignores empty ids/humanIds instead of writing garbage', () => {
    recordSessionOwner('', 'human-a');
    recordSessionOwner('claude-1', '');
    expect(getSessionOwner('claude-1')).toBeUndefined();
    expect(getSessionOwner('')).toBeUndefined();
  });
});
