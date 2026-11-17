import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetStore } from './asset-store';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ateam-store-'));
}

describe('AssetStore', () => {
  it('persists an experience and reloads it from disk', () => {
    const root = tmp();
    const s1 = new AssetStore(root);
    const e = s1.saveExperience({
      agentKey: 'coder',
      scope: 'project',
      projectId: 'p1',
      domain: 'wxpay',
      title: '微信支付 V3 签名失败',
      narrative: 'nonce_str 不在请求体内导致签名校验失败，调试 3 小时',
      lessonLearned: 'nonce_str 必须在请求体内',
      generalization: 'V3 签名失败常因参与签名字段不齐全',
      tags: ['wxpay', 'signature'],
      techStack: ['node'],
    });
    expect(e.appliedCount).toBe(0);

    // fresh instance reads it back from Markdown
    const s2 = new AssetStore(root);
    const list = s2.listExperiences({ agentKey: 'coder' });
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toContain('微信支付');
  });

  it('keyword search ranks a relevant prior experience first', () => {
    const root = tmp();
    const s = new AssetStore(root);
    s.saveExperience({
      agentKey: 'coder',
      scope: 'project',
      projectId: 'a',
      domain: 'wxpay',
      title: '微信支付签名',
      narrative: 'wxpay v3 signature nonce_str body',
      lessonLearned: 'nonce_str in body',
      tags: ['wxpay'],
    });
    s.saveExperience({
      agentKey: 'coder',
      scope: 'project',
      projectId: 'a',
      domain: 'css',
      title: 'flex 布局',
      narrative: 'flexbox alignment gap',
      lessonLearned: 'use gap',
      tags: ['css'],
    });
    const hits = s.search('coder', 'wxpay signature nonce', { domain: 'wxpay' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.exp.domain).toBe('wxpay');
  });

  it('markApplied bumps count and confidence, persists', () => {
    const root = tmp();
    const s = new AssetStore(root);
    const e = s.saveExperience({
      agentKey: 'coder',
      scope: 'project',
      projectId: 'a',
      domain: 'd',
      title: 't',
      narrative: 'n',
      lessonLearned: 'l',
    });
    const before = e.confidence.value;
    s.markApplied(e.id);
    const reloaded = new AssetStore(root).listExperiences({ agentKey: 'coder' })[0];
    expect(reloaded?.appliedCount).toBe(1);
    expect(reloaded?.confidence.value).toBeGreaterThan(before);
  });

  it('isolates by agentKey and scope', () => {
    const root = tmp();
    const s = new AssetStore(root);
    s.saveExperience({ agentKey: 'coder', scope: 'project', projectId: 'p', domain: 'd', title: 'c', narrative: 'n', lessonLearned: 'l' });
    s.saveExperience({ agentKey: 'reviewer', scope: 'global', domain: 'd', title: 'r', narrative: 'n', lessonLearned: 'l' });
    expect(s.listExperiences({ agentKey: 'coder' })).toHaveLength(1);
    expect(s.listExperiences({ agentKey: 'reviewer', scope: 'global' })).toHaveLength(1);
    expect(s.listExperiences({ agentKey: 'coder', scope: 'global' })).toHaveLength(0);
  });
});

describe('AssetStore skills', () => {
  it('persists a skill, reloads it, and recalls/searches it', () => {
    const root = tmp();
    const s1 = new AssetStore(root);
    s1.saveSkill({
      agentKey: 'coder',
      scope: 'global',
      kind: 'skill',
      domain: 'wxpay',
      name: 'WeChat Pay V3 集成流程',
      description: '标准接入步骤',
      body: '1. 配置证书\n2. nonce_str 放请求体\n3. 签名串顺序…',
      source: 'user_provided',
      tags: ['wxpay', 'payment'],
    });
    const s2 = new AssetStore(root);
    const list = s2.listSkills({ agentKey: 'coder' });
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toContain('WeChat Pay');
    // user_provided skills are curated -> eligible even on weak overlap
    const hits = s2.searchSkills('coder', 'unrelated query', {});
    expect(hits.length).toBe(1);
    // agentKey isolation
    expect(s2.listSkills({ agentKey: 'reviewer' })).toHaveLength(0);
  });
});

afterEach(() => {
  /* temp dirs are left for OS cleanup; isolated per test */
});
