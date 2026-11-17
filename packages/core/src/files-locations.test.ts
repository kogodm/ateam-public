import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFilesLocations, setFilesLocations } from './files-locations';

describe('Files-panel locations are shared, not per browser', () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-loc-'));
    prev = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });
  afterEach(() => {
    process.env.ATEAM_HOME = prev ?? '';
    rmSync(home, { recursive: true, force: true });
  });

  it('round-trips a scope, and keeps scopes apart', () => {
    setFilesLocations('/p/one', ['/a', '/b']);
    setFilesLocations('/p/two', ['/c']);
    expect(getFilesLocations('/p/one')).toEqual(['/a', '/b']);
    expect(getFilesLocations('/p/two')).toEqual(['/c']);
    expect(getFilesLocations('/p/three')).toEqual([]);
  });

  it('drops duplicates, trailing slashes and anything not absolute', () => {
    expect(setFilesLocations('/p', ['/a/', '/a', ' /b ', 'relative', ''])).toEqual(['/a', '/b']);
  });

  it('an emptied scope leaves no entry behind to accumulate', () => {
    setFilesLocations('/p', ['/a']);
    expect(setFilesLocations('/p', [])).toEqual([]);
    expect(getFilesLocations('/p')).toEqual([]);
  });

  it('a missing or malformed file reads as no locations, never throws', () => {
    expect(getFilesLocations('/never/written')).toEqual([]);
  });
});
