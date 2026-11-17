import { lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssetStore,
  type DistilledSkill,
  type LearnedItem,
  type LlmSynthesizer,
  type ReflectionItem,
} from '@ateam/knowledge';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Flywheel } from './flywheel/flywheel';
import { ensureHuman, projectKeyForDir, recordHumanProject } from './humans';
import { adoptAllHumansOnce, adoptHumanProjectSkills } from './skill-adopt';

class NoopSynth implements LlmSynthesizer {
  reflect(): Promise<ReflectionItem[]> {
    return Promise.resolve([]);
  }
  learnFromRepo(): Promise<LearnedItem[]> {
    return Promise.resolve([]);
  }
  distillSkill(): Promise<DistilledSkill> {
    return Promise.resolve({} as DistilledSkill);
  }
}

describe('adoptHumanProjectSkills', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-adopt-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
  });

  function mk(): { fw: Flywheel; store: AssetStore } {
    const store = new AssetStore(home);
    return { fw: new Flywheel(store, new NoopSynth()), store };
  }

  it('adopts into a readable project scope with a real capability description', () => {
    const proj = mkdtempSync(join(tmpdir(), 'ateam-proj-'));
    const rules = join(proj, 'CLAUDE.md');
    writeFileSync(rules, '# Project rules\nalways run pnpm -r typecheck before pushing\n');

    const h = ensureHuman({ name: 'nav', role: 'coder' });
    recordHumanProject(h.id, proj);
    const key = projectKeyForDir(h.id, proj);
    expect(key).not.toMatch(/^dir-[0-9a-f]/); // readable, not an opaque hash

    const { fw, store } = mk();
    const r = adoptHumanProjectSkills(fw, h.id);
    expect(r.dirs).toBe(1);
    expect(r.adopted).toBeGreaterThanOrEqual(1);

    // the ORIGINAL skill is never moved: it stays a real file in the project
    expect(lstatSync(rules).isSymbolicLink()).toBe(false);
    expect(lstatSync(rules).isFile()).toBe(true);
    // the VAULT holds only a symlink pointing back at the original
    const vaultEntry = join(store.skillContentDir(h.id, 'project', 'claude', key), 'CLAUDE.md');
    expect(lstatSync(vaultEntry).isSymbolicLink()).toBe(true);
    expect(realpathSync(vaultEntry)).toBe(realpathSync(rules));
    expect(readFileSync(vaultEntry, 'utf8')).toContain('always run pnpm -r typecheck');

    // 总纲 carries the capability line (so the LLM can judge relevance) and
    // is project-scoped: visible for THIS project, not in a global-only view
    const scoped = store.manifestText(h.id, { projectId: key });
    expect(scoped).toContain('always run pnpm -r typecheck before pushing');
    expect(scoped).not.toContain('files preserved');
    expect(store.manifestText(h.id, { globalOnly: true })).toBe('');

    // idempotent: original still real, vault link still a symlink, no throw
    expect(() => adoptHumanProjectSkills(fw, h.id)).not.toThrow();
    expect(lstatSync(rules).isSymbolicLink()).toBe(false);
    expect(lstatSync(vaultEntry).isSymbolicLink()).toBe(true);
  });

  it('one-time sweep runs once, then is a no-op', () => {
    const proj = mkdtempSync(join(tmpdir(), 'ateam-proj-'));
    writeFileSync(join(proj, '.cursorrules'), 'prefer immutable data structures\n');
    const h = ensureHuman({ name: 'sweep', role: 'coder' });
    recordHumanProject(h.id, proj);

    const { fw } = mk();
    const first = adoptAllHumansOnce(fw);
    expect(first.ran).toBe(true);
    expect(first.adopted).toBeGreaterThanOrEqual(1);

    const second = adoptAllHumansOnce(fw);
    expect(second.ran).toBe(false);
    expect(second.adopted).toBe(0);
  });
});
