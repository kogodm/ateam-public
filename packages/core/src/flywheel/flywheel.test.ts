import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssetStore,
  type DistilledSkill,
  type ExperienceDraft,
  type LearnedItem,
  type LlmSynthesizer,
  type ReflectionItem,
} from '@ateam/knowledge';
import { describe, expect, it } from 'vitest';
import { Flywheel } from './flywheel';

class FakeSynth implements LlmSynthesizer {
  constructor(private readonly draft: ExperienceDraft) {}
  reflect(): Promise<ReflectionItem[]> {
    return Promise.resolve([
      {
        kind: 'experience',
        domain: this.draft.domain,
        title: this.draft.title,
        body: this.draft.narrative,
        lessonLearned: this.draft.lessonLearned,
        generalization: this.draft.generalization,
        tags: this.draft.tags,
        techStack: this.draft.techStack,
      },
    ]);
  }
  learnFromRepo(): Promise<LearnedItem[]> {
    return Promise.resolve([
      {
        kind: 'skill',
        domain: 'build',
        name: 'pnpm monorepo',
        description: 'workspace layout',
        body: 'use pnpm -r',
        tags: ['pnpm'],
      },
    ]);
  }
  distillSkill(domain: string): Promise<DistilledSkill> {
    return Promise.resolve({
      name: `${domain} playbook`,
      domain,
      description: 'distilled',
      body: 'steps…',
      tags: [domain],
    });
  }
}

const wxpayDraft: ExperienceDraft = {
  domain: 'wxpay',
  title: '微信支付 V3 签名失败排查',
  narrative: 'nonce_str 未放入请求体导致签名校验失败，调试约 3 小时',
  lessonLearned: 'WeChat Pay V3 参与签名的字段必须齐全，nonce_str 在请求体内',
  generalization: '签名失败优先核对参与签名字段是否齐全',
  tags: ['wxpay', 'signature', 'nonce_str'],
  techStack: ['node'],
};

describe('Flywheel (M2 single-agent slice)', () => {
  it('reflects a transcript into a stored Experience, then recalls it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-fw-'));
    const store = new AssetStore(root);
    const fw = new Flywheel(store, new FakeSynth(wxpayDraft));

    const out = await fw.reflectFromText('user: 接微信支付\nassistant: 签名一直失败…', {
      cwd: '/x',
      claudeSessionId: 's1',
      agentKey: 'coder',
      scope: 'project',
      projectId: 'peizhen',
      domainHint: 'wxpay',
    });
    const exp = out.experiences[0];
    if (!exp) throw new Error('expected one experience');
    expect(exp.domain).toBe('wxpay');
    expect(exp.appliedCount).toBe(0);

    // a new task in the same domain recalls the prior experience first
    const hits = fw.recall('coder', '微信支付 签名 nonce', { domain: 'wxpay' });
    expect(hits[0]?.exp.id).toBe(exp.id);

    // applying it reinforces confidence (visible growth ④)
    const before = hits[0]?.exp.confidence.value ?? 0;
    fw.markApplied(exp.id);
    const after = new AssetStore(root).listExperiences({ agentKey: 'coder' })[0];
    expect(after?.appliedCount).toBe(1);
    expect(after?.confidence.value ?? 0).toBeGreaterThan(before);
  });

  it('does not cross agentKey boundaries on recall', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-fw-'));
    const store = new AssetStore(root);
    const fw = new Flywheel(store, new FakeSynth(wxpayDraft));
    await fw.reflectFromText('t', {
      cwd: '/x',
      claudeSessionId: 's',
      agentKey: 'coder',
      scope: 'project',
      projectId: 'p',
      domainHint: 'wxpay',
    });
    expect(fw.recall('reviewer', 'wxpay signature', { domain: 'wxpay' })).toHaveLength(0);
    expect(fw.recall('coder', 'wxpay signature', { domain: 'wxpay' }).length).toBeGreaterThan(0);
  });

  it('② distills ≥3 same-domain experiences into a Skill and ④ reinforces them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-fw-'));
    const store = new AssetStore(root);
    const fw = new Flywheel(store, new FakeSynth(wxpayDraft));
    for (let i = 0; i < 3; i++)
      store.saveExperience({
        agentKey: 'h1',
        scope: 'project',
        projectId: `p${i}`,
        domain: 'wxpay',
        title: `wxpay issue ${i}`,
        narrative: 'n',
        lessonLearned: 'sign fields must be complete',
        generalization: 'verify signed fields',
      });
    expect(await fw.distillDomain('h1', 'css')).toBeNull(); // <3
    const used = await fw.distillDomain('h1', 'wxpay');
    expect(used).toHaveLength(3);
    const skills = store.listSkills({ agentKey: 'h1' });
    expect(skills.filter((s) => s.source === 'distilled')).toHaveLength(1);
    // contributors reinforced (④)
    expect(store.listExperiences({ agentKey: 'h1' }).every((e) => e.appliedCount === 1)).toBe(true);
  });

  it('imports user Skill docs and learns from a project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-fw-'));
    const skillsDir = mkdtempSync(join(tmpdir(), 'ateam-skills-'));
    writeFileSync(
      join(skillsDir, 'wxpay.md'),
      '---\ndomain: wxpay\ntags: wxpay, payment\n---\n# WeChat Pay 集成\n步骤…',
    );
    const store = new AssetStore(root);
    const fw = new Flywheel(store, new FakeSynth(wxpayDraft));

    const imported = fw.importSkillsFromDir('coder', skillsDir, 'global');
    expect(imported).toBe(1);
    const learned = await fw.learnFromProject('coder', root, 'global');
    expect(learned).toBe(1);

    const skills = new AssetStore(root).listSkills({ agentKey: 'coder' });
    expect(skills).toHaveLength(2);
    expect(skills.some((s) => s.source === 'user_provided' && s.domain === 'wxpay')).toBe(true);
    expect(skills.some((s) => s.source === 'learned')).toBe(true);
  });
});
