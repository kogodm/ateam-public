import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Flywheel } from './flywheel/flywheel';
import { getHuman, listHumans, projectKeyForDir } from './humans';
import { ateamHome } from './paths';
import { assignSkillUnit } from './skill-assignments';
import { discoverSkillUnits } from './skill-sources';

export interface AdoptResult {
  adopted: number;
  dirs: number;
}

/**
 * For every directory a Human has worked in, pull the skills/rules living
 * there into the Human's own vault: `importSkillUnit` ADOPTS each unit (real
 * files move to ~/.ateam, original path becomes a symlink), so in-session
 * edits stay tracked. Idempotent — already-adopted units resolve into the
 * vault and are skipped. Only project-local units (under the dir itself) are
 * adopted here; global Claude/Cursor/Codex sources are handled at setup.
 *
 * Scope = PROJECT (not global): a project's own rules stay isolated to that
 * project (honors the 2D project/global model — global only via the reviewed
 * promotion path). The project is keyed by a stable id derived from the dir,
 * so recall while working in that dir picks them up; other projects don't.
 *
 * Guard: a project-local unit whose path already resolves INTO this human's
 * global vault was deliberately adopted globally (e.g. ~/.claude assigned at
 * setup, symlinked into a project) — global stays global; never duplicate it
 * as a project-scoped record.
 */
export function adoptHumanProjectSkills(flywheel: Flywheel, humanId: string): AdoptResult {
  const human = getHuman(humanId);
  if (!human) return { adopted: 0, dirs: 0 };
  const realAteam = (() => {
    try {
      return realpathSync(ateamHome());
    } catch {
      return ateamHome();
    }
  })();
  const globalVault = join(realAteam, 'users', 'local', 'agents', humanId, 'global');
  let adopted = 0;
  let dirs = 0;
  for (const p of human.projects) {
    if (!existsSync(p.dir)) continue;
    dirs++;
    const projectId = projectKeyForDir(humanId, p.dir);
    for (const u of discoverSkillUnits(p.dir)) {
      if (u.origin !== 'project') continue; // globals are setup-time, not per-dir
      let realPath = u.path;
      try {
        realPath = realpathSync(u.path);
      } catch {
        /* not yet a symlink / unreadable — treat as not-yet-adopted */
      }
      // already adopted globally → leave it global, don't make a project dup
      if (realPath === globalVault || realPath.startsWith(globalVault + sep)) continue;
      try {
        const n = flywheel.importSkillUnit(humanId, u.path, u.kind, u.entry, 'project', projectId);
        if (n > 0) {
          assignSkillUnit(u.path, humanId, human.name);
          adopted += n;
        }
      } catch {
        /* skip an unreadable / racing unit */
      }
    }
  }
  return { adopted, dirs };
}

// v2: readable project-scoped keys + skill capability descriptions. Bumping
// the marker re-runs the one-time sweep once on upgrade so already-adopted
// units get re-registered under the readable scope (non-destructive: the
// vault files & symlinks are intact; importSkillUnit is idempotent).
const SWEEP_MARKER = (): string => join(ateamHome(), '.skill-adopt-v2');

/**
 * One-time backfill: on the first open after this feature ships, adopt the
 * project-dir skills of EVERY known human. Guarded by a marker file so it
 * runs exactly once (subsequent restores are no-ops). `force` re-runs it.
 */
export function adoptAllHumansOnce(
  flywheel: Flywheel,
  force = false,
): AdoptResult & { ran: boolean } {
  if (!force && existsSync(SWEEP_MARKER())) return { adopted: 0, dirs: 0, ran: false };
  let adopted = 0;
  let dirs = 0;
  for (const h of listHumans()) {
    const r = adoptHumanProjectSkills(flywheel, h.id);
    adopted += r.adopted;
    dirs += r.dirs;
  }
  try {
    writeFileSync(SWEEP_MARKER(), new Date().toISOString());
  } catch {
    /* marker is best-effort; importSkillUnit is itself idempotent */
  }
  return { adopted, dirs, ran: true };
}
