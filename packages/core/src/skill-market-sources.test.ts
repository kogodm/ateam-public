import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSource,
  getSource,
  listSources,
  removeSource,
  repoToId,
  setSourceEnabled,
} from './skill-market-sources';

// The sources config lives under ateamHome() (ATEAM_HOME) — isolate per test.
let home: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.ATEAM_HOME;
  home = mkdtempSync(join(tmpdir(), 'ateam-src-'));
  process.env.ATEAM_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.ATEAM_HOME;
  else process.env.ATEAM_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe('skill-market-sources', () => {
  it('seeds builtin + the shipped default marketplaces', () => {
    const s = listSources();
    expect(s[0]?.id).toBe('builtin');
    expect(s.map((x) => x.id)).toEqual(
      expect.arrayContaining(['builtin', 'official', 'anthropics-skills', 'daymade']),
    );
    expect(s.every((x) => x.enabled)).toBe(true);
  });

  it('repoToId normalizes owner/repo and URLs', () => {
    expect(repoToId('Owner/Repo')).toBe('owner-repo');
    expect(repoToId('https://github.com/a/b.git')).toBe('a-b');
  });

  it('toggles enable/disable and persists', () => {
    setSourceEnabled('official', false);
    expect(getSource('official')?.enabled).toBe(false);
    setSourceEnabled('official', true);
    expect(getSource('official')?.enabled).toBe(true);
  });

  it('cannot disable or remove builtin', () => {
    expect(setSourceEnabled('builtin', false)?.enabled).toBe(true);
    expect(removeSource('builtin')).toBe(false);
    expect(getSource('builtin')).toBeDefined();
  });

  it('adds a custom source (enabled) and removes it', () => {
    const s = addSource({ repo: 'foo/bar' });
    expect(s.id).toBe('foo-bar');
    expect(s.enabled).toBe(true);
    expect(getSource('foo-bar')).toBeDefined();
    expect(removeSource('foo-bar')).toBe(true);
    expect(getSource('foo-bar')).toBeUndefined();
  });

  it('adds discovered sources DISABLED (opt-in)', () => {
    const s = addSource({ repo: 'new/found', discovered: true });
    expect(s.enabled).toBe(false);
    expect(s.discovered).toBe(true);
  });

  it('removing a default hides it but survives as removable', () => {
    expect(getSource('daymade')).toBeDefined();
    expect(removeSource('daymade')).toBe(true);
    expect(getSource('daymade')).toBeUndefined();
    // re-adding by repo brings it back enabled
    addSource({ repo: 'daymade/claude-code-skills' });
    expect(getSource('daymade-claude-code-skills')?.enabled).toBe(true);
  });
});
