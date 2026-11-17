import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketSource } from '@ateam/contract';
import { afterAll, describe, expect, it } from 'vitest';
import { findSkillUnits, parseMarketplace } from './skill-market-remote';

const src: MarketSource = {
  id: 'src',
  name: 'Src',
  kind: 'marketplace',
  repo: 'owner/repo',
  enabled: true,
};

describe('parseMarketplace', () => {
  it('resolves object git-subdir sources (official shape)', () => {
    const doc = {
      plugins: [
        {
          name: '42crunch-api-security-testing',
          description: 'Automate API security',
          author: { name: '42Crunch' },
          category: 'security',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/42Crunch-AI/claude-plugins.git',
            path: 'plugins/api-security-testing',
            ref: 'v1.5.5',
            sha: '30287f5e',
          },
        },
      ],
    };
    const [item] = parseMarketplace(doc, src);
    expect(item?.id).toBe('src:42crunch-api-security-testing');
    expect(item?.author).toBe('42Crunch');
    expect(item?.category).toBe('security');
    expect(item?.remote?.repoUrl).toBe('https://github.com/42Crunch-AI/claude-plugins.git');
    expect(item?.remote?.path).toBe('plugins/api-security-testing');
    expect(item?.remote?.ref).toBe('v1.5.5');
    expect(item?.remote?.sha).toBe('30287f5e');
    expect(item?.builtin).toBe(false);
    expect(item?.sourceId).toBe('src');
  });

  it('resolves relative string sources against the host repo', () => {
    const doc = {
      plugins: [
        { name: 'document-skills', description: 'docs', source: './' },
        { name: 'bilibili-source', description: 'b站', source: './plugins/bilibili' },
      ],
    };
    const items = parseMarketplace(doc, src);
    expect(items).toHaveLength(2);
    expect(items[0]?.remote?.repoUrl).toBe('https://github.com/owner/repo.git');
    expect(items[0]?.remote?.path).toBe(''); // "./" → repo root
    expect(items[1]?.remote?.path).toBe('plugins/bilibili');
  });

  it('skips plugins without a name or resolvable source', () => {
    const doc = {
      plugins: [
        { description: 'no name', source: './x' },
        { name: 'no-source' },
        { name: 'null-source', source: null },
      ],
    };
    expect(parseMarketplace(doc, src)).toHaveLength(0);
  });

  it('drops relative sources when the host repo is unknown', () => {
    const noRepo: MarketSource = { ...src, repo: undefined };
    const doc = { plugins: [{ name: 'x', source: './x' }] };
    expect(parseMarketplace(doc, noRepo)).toHaveLength(0);
  });

  it('tolerates a non-array / empty plugins field', () => {
    expect(parseMarketplace({}, src)).toHaveLength(0);
    expect(parseMarketplace({ plugins: 'nope' }, src)).toHaveLength(0);
  });
});

describe('findSkillUnits', () => {
  const root = mkdtempSync(join(tmpdir(), 'ateam-units-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds skills/<name>/SKILL.md and a root SKILL.md', () => {
    const multi = join(root, 'multi');
    mkdirSync(join(multi, 'a'), { recursive: true });
    mkdirSync(join(multi, 'b'), { recursive: true });
    writeFileSync(join(multi, 'a', 'SKILL.md'), '# a');
    writeFileSync(join(multi, 'b', 'SKILL.md'), '# b');
    const units = findSkillUnits(multi);
    expect(units.sort()).toEqual([join(multi, 'a'), join(multi, 'b')].sort());

    const single = join(root, 'single');
    mkdirSync(single, { recursive: true });
    writeFileSync(join(single, 'SKILL.md'), '# root');
    expect(findSkillUnits(single)).toEqual([single]);
  });

  it('returns nothing for a dir with no SKILL.md', () => {
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'README.md'), '# readme');
    expect(findSkillUnits(empty)).toEqual([]);
  });
});
