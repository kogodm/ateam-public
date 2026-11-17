import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installationId } from './installation';

let home: string;
const prev = process.env.ATEAM_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ateam-inst-'));
  process.env.ATEAM_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.ATEAM_HOME;
  else process.env.ATEAM_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe('installationId', () => {
  it('is created once and stays the same', () => {
    const id = installationId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(installationId()).toBe(id);
  });

  it('replaces a file it cannot read', () => {
    writeFileSync(join(home, 'installation.json'), '{broken');
    expect(installationId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
