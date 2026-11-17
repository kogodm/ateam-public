import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { AssetStore, StoredSkill } from '@ateam/knowledge';
import { isStaleDescription, skillCapability } from './skill-capability';

export interface SkillMigrationResult {
  removedDuplicates: number;
  refreshedDescriptions: number;
}

const GLOBAL_FRAGMENT = `${sep}global${sep}skills${sep}`;

/** A skill record's real files live under SOME human's global vault. */
function bundleIsGlobal(sk: StoredSkill): boolean {
  const b = sk.bundlePath;
  if (!b) return false;
  let real = b;
  try {
    real = realpathSync(b);
  } catch {
    /* path may be gone; the raw string is still indicative */
  }
  return `${real}${sep}`.includes(GLOBAL_FRAGMENT) || `${b}${sep}`.includes(GLOBAL_FRAGMENT);
}

/** Best-effort: the markdown the capability blurb should come from. */
function entryMarkdown(sk: StoredSkill): string {
  const bp = sk.bundlePath;
  if (bp && existsSync(bp)) {
    try {
      const st = statSync(bp);
      const file = st.isDirectory() ? (sk.entryFile ? join(bp, sk.entryFile) : '') : bp;
      if (file && existsSync(file)) return readFileSync(file, 'utf8');
    } catch {
      /* fall through to body */
    }
  }
  return sk.body ?? '';
}

/**
 * One-time corrective migration (idempotent, markerless — safe every start):
 *
 *  Bug A — global stays global: an earlier broken sweep re-registered a
 *  project-dir unit that was ALREADY adopted globally as a second,
 *  project-scoped record pointing back into …/global/skills/. Delete those
 *  spurious project duplicates (only when the canonical global twin exists,
 *  so no skill is ever lost; the bundle files are untouched).
 *
 *  Bug B — the 总纲 carried no real capability text: records imported before
 *  the description fix kept the useless "bundle (…); files preserved" / empty
 *  blurb. Re-derive each stale one from its entry doc so the LLM can judge
 *  relevance.
 */
export function migrateSkillRecords(store: AssetStore): SkillMigrationResult {
  const all = store.allSkills();
  let removedDuplicates = 0;
  let refreshedDescriptions = 0;

  // (A) drop project-scoped dups whose files are really in the global vault
  for (const sk of all) {
    if (sk.scope !== 'project' || !bundleIsGlobal(sk)) continue;
    const twin = all.find(
      (g) =>
        g.scope === 'global' &&
        g.agentKey === sk.agentKey &&
        (g.bundlePath === sk.bundlePath || g.name === sk.name),
    );
    if (twin) {
      store.deleteSkill(sk.id);
      removedDuplicates++;
    }
  }

  // (B) refresh stale/empty capability descriptions from the entry doc
  for (const sk of store.allSkills()) {
    if (!isStaleDescription(sk.description)) continue;
    const cap = skillCapability(entryMarkdown(sk));
    if (cap && cap !== sk.description) {
      store.updateSkillDescription(sk.id, cap);
      refreshedDescriptions++;
    }
  }

  return { removedDuplicates, refreshedDescriptions };
}
