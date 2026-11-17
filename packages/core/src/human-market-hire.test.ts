import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetStore } from '@ateam/knowledge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Flywheel } from './flywheel/flywheel';
import { getHumanMarketItem } from './human-market';
import { ensureHuman } from './humans';
import { ateamHome } from './paths';
import { entryPathFor, getMarketItem, resolveMarketSource } from './skill-market';

/**
 * Integration guard for the Human Market's promise: hiring a prefab must land
 * REAL skill bodies on the human, not empty records. Mirrors what the
 * `human.market.hire` handler does (ensureHuman + per-skill importSkillUnit).
 */
let home: string;
let prev: string | undefined;

beforeAll(() => {
  prev = process.env.ATEAM_HOME;
  home = mkdtempSync(join(tmpdir(), 'ateam-hire-'));
  process.env.ATEAM_HOME = home;
});
afterAll(() => {
  if (prev === undefined) delete process.env.ATEAM_HOME;
  else process.env.ATEAM_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe('hiring a prefab human installs real skill content', () => {
  it('lands every built-in skill with a non-trivial body', async () => {
    const item = getHumanMarketItem('backend-engineer');
    expect(item).toBeDefined();
    if (!item) return;

    const store = new AssetStore(ateamHome());
    // importSkillUnit never touches the synthesizer — a stub is enough.
    const fw = new Flywheel(store, {} as never);
    const human = ensureHuman({ name: item.name, role: item.role });

    let imported = 0;
    for (const sid of item.skillIds) {
      const skill = getMarketItem(sid);
      expect(skill, `market item ${sid}`).toBeDefined();
      if (!skill) continue;
      const dir = await resolveMarketSource(skill);
      // must match the handler: DIR for tree/bundle units, file for 'file'
      const unitPath = skill.kind === 'file' ? entryPathFor(dir, skill) : dir;
      imported += fw.importSkillUnit(human.id, unitPath, skill.kind, skill.entry, 'global');
    }
    expect(imported).toBe(item.skillIds.length);

    const records = store.allSkills().filter((s) => s.agentKey === human.id);
    expect(records.length).toBe(item.skillIds.length);
    for (const r of records) {
      // real doc, not a placeholder shell
      expect(r.body.length, `${r.name} body`).toBeGreaterThan(500);
      expect(r.body).toContain('# 检查清单');
      expect(r.name).not.toBe('SKILL');
      expect(r.description.length).toBeGreaterThan(0);
    }
  });
});
