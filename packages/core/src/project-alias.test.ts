import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getProjectAlias,
  projectAliasPath,
  projectAliases,
  setProjectAlias,
} from './project-alias';

describe('project aliases', () => {
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = mkdtempSync(join(tmpdir(), 'ateam-alias-'));
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prev;
  });

  it('returns undefined before anything is set', () => {
    expect(getProjectAlias('/repo/.git')).toBeUndefined();
    expect(projectAliases()).toEqual({});
  });

  it('stores and reads back an alias, trimming it', () => {
    setProjectAlias('/repo/.git', '  麻将主仓  ');
    expect(getProjectAlias('/repo/.git')).toBe('麻将主仓');
    expect(projectAliases()).toEqual({ '/repo/.git': '麻将主仓' });
  });

  it('keeps aliases for different projects apart', () => {
    setProjectAlias('desk:human-1', 'Xlan 的桌面');
    expect(getProjectAlias('/repo/.git')).toBe('麻将主仓');
    expect(getProjectAlias('desk:human-1')).toBe('Xlan 的桌面');
  });

  it('an empty alias clears the entry rather than storing a blank', () => {
    setProjectAlias('/repo/.git', '   ');
    expect(getProjectAlias('/repo/.git')).toBeUndefined();
    expect(Object.keys(projectAliases())).toEqual(['desk:human-1']);
  });

  it('caps the alias length', () => {
    setProjectAlias('/long', 'x'.repeat(120));
    expect(getProjectAlias('/long')).toHaveLength(60);
  });

  it('ignores an empty key and survives a malformed store', () => {
    setProjectAlias('', 'nope');
    expect(projectAliases()['']).toBeUndefined();
    // the file is plain JSON; a torn/hand-edited one must degrade to "no
    // aliases", never throw into the tree render
    const before = readFileSync(projectAliasPath(), 'utf8');
    expect(() => JSON.parse(before)).not.toThrow();
  });
});
