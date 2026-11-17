import type { SkillUnitDTO } from '@ateam/contract';
import { describe, expect, it } from 'vitest';
import { groupPluginUnits, pluginMemberLabel } from './skillGroups';

const unit = (label: string): SkillUnitDTO => ({
  path: `/p/${label}`,
  label,
  origin: 'global-claude',
  kind: 'bundle',
  entry: 'SKILL.md',
  docCount: 1,
  assignedTo: [],
});

describe('groupPluginUnits (#14)', () => {
  it('merges every unit of one plugin into a single card, keeps others alone', () => {
    const groups = groupPluginUnits([
      unit('my-skill/'),
      unit('plugin:ecc@market/skills/a/'),
      unit('plugin:ecc@market/skills/b/'),
      unit('plugin:ecc@market/commands/c.md'),
      unit('plugin:other@market/skills/x/'),
    ]);
    expect(groups.map((g) => [g.title, g.subtitle, g.plugin, g.units.length])).toEqual([
      ['my-skill/', '', false, 1],
      ['ecc', '@market', true, 3],
      ['other', '@market', true, 1],
    ]);
    expect(groups[1]?.units.map(pluginMemberLabel)).toEqual([
      'skills/a',
      'skills/b',
      'commands/c.md',
    ]);
  });
  it('keeps the same plugin name from two marketplaces apart', () => {
    const groups = groupPluginUnits([
      unit('plugin:ecc@m1/skills/a/'),
      unit('plugin:ecc@m2/skills/a/'),
    ]);
    expect(groups).toHaveLength(2);
  });
});
