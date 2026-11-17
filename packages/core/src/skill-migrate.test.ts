import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetStore } from '@ateam/knowledge';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateSkillRecords } from './skill-migrate';

const STALE = 'bundle (bundle); files preserved at the path below';

describe('migrateSkillRecords', () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-mig-'));
    prev = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prev;
  });

  it('drops global→project dup records and refreshes stale 总纲 blurbs', () => {
    const store = new AssetStore(home);
    const agent = 'agent-uuid';

    // a real global bundle whose entry doc carries a description
    const bundle = store.skillContentDir(agent, 'global', 'claude');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(
      join(bundle, 'SKILL.md'),
      '---\ndescription: Drive Claude Code via the CLI\n---\n# claude\nbody\n',
    );

    // canonical GLOBAL record (stale description, like pre-fix imports)
    store.saveSkill({
      agentKey: agent,
      scope: 'global',
      kind: 'skill',
      domain: 'claude',
      name: 'claude',
      description: STALE,
      body: '',
      source: 'user_provided',
      bundlePath: bundle,
      entryFile: 'SKILL.md',
    });
    // spurious PROJECT dup pointing back into the SAME global bundle
    store.saveSkill({
      agentKey: agent,
      scope: 'project',
      projectId: 'badminton',
      kind: 'skill',
      domain: 'claude',
      name: 'claude',
      description: STALE,
      body: '',
      source: 'user_provided',
      bundlePath: bundle,
      entryFile: 'SKILL.md',
    });

    const r = migrateSkillRecords(store);
    expect(r.removedDuplicates).toBe(1);
    expect(r.refreshedDescriptions).toBeGreaterThanOrEqual(1);

    // project dup gone; global kept, now with the real capability blurb
    expect(store.manifestText(agent, { projectId: 'badminton' })).not.toContain('files preserved');
    const all = store.manifestText(agent);
    expect(all).toContain('Drive Claude Code via the CLI');
    expect(all).not.toContain('files preserved');
    expect(store.allSkills().filter((s) => s.scope === 'project')).toHaveLength(0);
  });

  it('is idempotent and leaves healthy records untouched', () => {
    const store = new AssetStore(home);
    store.saveSkill({
      agentKey: 'a',
      scope: 'project',
      projectId: 'p',
      kind: 'skill',
      domain: 'x',
      name: 'good',
      description: 'a clear capability line',
      body: 'detail',
      source: 'user_provided',
      bundlePath: store.skillContentDir('a', 'project', 'good', 'p'),
    });
    const first = migrateSkillRecords(store);
    const second = migrateSkillRecords(store);
    expect(first.removedDuplicates).toBe(0);
    expect(second).toEqual({ removedDuplicates: 0, refreshedDescriptions: 0 });
    expect(store.manifestText('a', { projectId: 'p' })).toContain('a clear capability line');
  });
});
