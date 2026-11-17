import type { SkillUnitDTO } from '@ateam/contract';

/** One card in the Skills grid: either a lone unit or every unit shipped by
 *  the same Claude Code plugin (issue #14 — a plugin with 40 skills used to
 *  flood the grid with 40 identical-looking `plugin:…` cards). */
export interface SkillCardGroup {
  /** stable key for React + expand state */
  readonly key: string;
  /** card title: the plugin name (without marketplace) or the unit label */
  readonly title: string;
  /** secondary text: `@marketplace` for plugins, '' otherwise */
  readonly subtitle: string;
  readonly plugin: boolean;
  readonly units: readonly SkillUnitDTO[];
}

const PLUGIN_RE = /^plugin:([^/@]+)(?:@([^/]+))?\/(.*)$/;

/** the part of a plugin unit's label after `plugin:<key>/`, e.g.
 *  `skills/foo/` → `skills/foo` — what the expanded card lists per unit. */
export function pluginMemberLabel(u: SkillUnitDTO): string {
  const m = PLUGIN_RE.exec(u.label);
  return (m?.[3] ?? u.label).replace(/\/$/, '');
}

export function groupPluginUnits(units: readonly SkillUnitDTO[]): SkillCardGroup[] {
  const out: SkillCardGroup[] = [];
  const byPlugin = new Map<string, SkillCardGroup>();
  for (const u of units) {
    const m = PLUGIN_RE.exec(u.label);
    if (!m) {
      out.push({ key: u.path, title: u.label, subtitle: '', plugin: false, units: [u] });
      continue;
    }
    const [, name, marketplace = ''] = m;
    const key = `plugin:${name}@${marketplace}`;
    const cur = byPlugin.get(key);
    if (cur) {
      // immutable append: replace the group in both the index and the list
      const next: SkillCardGroup = { ...cur, units: [...cur.units, u] };
      byPlugin.set(key, next);
      out[out.indexOf(cur)] = next;
    } else {
      const g: SkillCardGroup = {
        key,
        title: name ?? u.label,
        subtitle: marketplace ? `@${marketplace}` : '',
        plugin: true,
        units: [u],
      };
      byPlugin.set(key, g);
      out.push(g);
    }
  }
  return out;
}
