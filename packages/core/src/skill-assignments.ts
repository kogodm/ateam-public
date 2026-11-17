import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ateamHome } from './paths';

/**
 * Which skill units (by canonical source path) have been assigned to which
 * humans — so the setup wizard can mark already-assigned skills when
 * configuring another human.
 */
export interface Assignment {
  humanId: string;
  humanName: string;
  at: string;
}

function file(): string {
  return join(ateamHome(), 'skill-assignments.json');
}

function loadAll(): Record<string, Assignment[]> {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Record<string, Assignment[]>;
  } catch {
    return {};
  }
}

export function assignmentsFor(unitPath: string): Assignment[] {
  return loadAll()[unitPath] ?? [];
}

export function assignSkillUnit(unitPath: string, humanId: string, humanName: string): void {
  const all = loadAll();
  const list = all[unitPath] ?? [];
  if (!list.some((a) => a.humanId === humanId)) {
    list.push({ humanId, humanName, at: new Date().toISOString() });
  }
  all[unitPath] = list;
  mkdirSync(ateamHome(), { recursive: true });
  writeFileSync(file(), JSON.stringify(all, null, 2));
}

/** Reverse of assignSkillUnit. Returns the number of records removed (0 or 1
 *  per (unit,human) pair). The vault symlink + asset-store entry is the
 *  caller's responsibility — assignments are the canonical source of truth
 *  for *which* human has *which* unit; the rest is rebuilt on next spawn. */
export function unassignSkillUnit(unitPath: string, humanId: string): number {
  const all = loadAll();
  const list = all[unitPath];
  if (!list?.length) return 0;
  const next = list.filter((a) => a.humanId !== humanId);
  if (next.length === list.length) return 0;
  if (next.length) all[unitPath] = next;
  else delete all[unitPath];
  mkdirSync(ateamHome(), { recursive: true });
  writeFileSync(file(), JSON.stringify(all, null, 2));
  return list.length - next.length;
}
