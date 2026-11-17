import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssetStore,
  type DistilledSkill,
  type LearnedItem,
  type LlmSynthesizer,
  type ReflectionItem,
} from '@ateam/knowledge';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureHuman } from '../humans';
import { Flywheel } from './flywheel';
import { MetaAgent, type SessionSource } from './meta-agent';

class FakeSynth implements LlmSynthesizer {
  reflect(): Promise<ReflectionItem[]> {
    return Promise.resolve([]);
  }
  learnFromRepo(): Promise<LearnedItem[]> {
    return Promise.resolve([]);
  }
  distillSkill(domain: string): Promise<DistilledSkill> {
    return Promise.resolve({
      name: `${domain} playbook`,
      domain,
      description: 'd',
      body: 'b',
      tags: [],
    });
  }
}

const noSessions: SessionSource = {
  list: () => [],
  get: () => undefined,
  on: () => undefined,
};

describe('MetaAgent autonomous flywheel', () => {
  const prev = process.env.ATEAM_HOME;
  afterEach(() => {
    if (prev === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prev;
  });

  it('runNow distills ≥3 same-domain experiences once (idempotent)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ateam-meta-'));
    process.env.ATEAM_HOME = home;
    const h = ensureHuman({ name: '小明', role: 'coder' });
    const store = new AssetStore(home);
    for (let i = 0; i < 3; i++)
      store.saveExperience({
        agentKey: h.id,
        scope: 'project',
        projectId: `p${i}`,
        domain: 'wxpay',
        title: `t${i}`,
        narrative: 'n',
        lessonLearned: 'l',
        generalization: 'g',
      });
    const meta = new MetaAgent(noSessions, new Flywheel(store, new FakeSynth()));

    const r1 = await meta.runNow();
    expect(r1.reflected).toBe(0); // no live sessions
    expect(r1.distilled).toBe(1);
    expect(
      store.listSkills({ agentKey: h.id }).filter((s) => s.source === 'distilled'),
    ).toHaveLength(1);

    const r2 = await meta.runNow(); // same count -> no re-distill
    expect(r2.distilled).toBe(0);
  });
});
