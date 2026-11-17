import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureHumanMetaDir,
  humanMetaDir,
  humanMetaPath,
  readHumanMeta,
} from './human-meta';

describe('human-meta', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-meta-'));
    process.env.ATEAM_HOME = home;
  });
  afterEach(() => {
    process.env.ATEAM_HOME = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it('ensureHumanMetaDir creates the meta + content subdirs', () => {
    const dir = ensureHumanMetaDir('human-1');
    expect(dir).toBe(humanMetaDir('human-1'));
    for (const sub of ['skills', 'knowledge', 'experiences']) {
      expect(existsSync(join(dir, sub))).toBe(true);
    }
  });

  it('readHumanMeta returns "" when no meta.md yet', () => {
    expect(readHumanMeta('nobody')).toBe('');
  });

  it('readHumanMeta returns the trimmed meta.md content', () => {
    ensureHumanMetaDir('human-2');
    writeFileSync(humanMetaPath('human-2'), '\n# index\n- a → skills/a/SKILL.md\n');
    expect(readHumanMeta('human-2')).toBe('# index\n- a → skills/a/SKILL.md');
  });
});
