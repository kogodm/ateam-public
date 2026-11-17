import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ateamHome } from './paths';

/**
 * Extra Files-panel locations the user has added, per project —
 * `~/.ateam/files-locations.json`.
 *
 * These used to live in localStorage, which is per BROWSER: the desktop's
 * webview and a phone's Safari keep separate stores, so a directory added at
 * the desk was invisible on the phone (and the other way round) with nothing
 * on screen to explain why. They are a property of the project, not of the
 * screen you happened to add them from, so they belong next to the machine's
 * other project-keyed state.
 *
 * The key is the project scope the panel already used — the session cwd — so
 * one project's extra dirs never leak into another.
 */
interface FileShape {
  /** scope (session cwd) -> absolute directories */
  locations: Record<string, string[]>;
}

function locationsPath(): string {
  return join(ateamHome(), 'files-locations.json');
}

function load(): FileShape {
  try {
    const j = JSON.parse(readFileSync(locationsPath(), 'utf8')) as FileShape;
    return j && typeof j.locations === 'object' ? { locations: j.locations } : { locations: {} };
  } catch {
    return { locations: {} }; // missing / malformed → none
  }
}

/** Atomic write (temp + rename) — two clients can add a directory at once. */
function save(s: FileShape): void {
  const file = locationsPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file);
}

const clean = (list: readonly string[]): string[] => {
  const out: string[] = [];
  for (const raw of list) {
    const d = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
    if (d.startsWith('/') && !out.includes(d)) out.push(d);
  }
  return out.slice(0, 32);
};

export function getFilesLocations(scope: string): string[] {
  if (!scope) return [];
  return clean(load().locations[scope] ?? []);
}

/** Replace one scope's list. An empty list drops the entry rather than
 *  leaving `"/some/dir": []` behind to accumulate forever. */
export function setFilesLocations(scope: string, list: readonly string[]): string[] {
  if (!scope) return [];
  const s = load();
  const next = clean(list);
  if (next.length === 0) delete s.locations[scope];
  else s.locations[scope] = next;
  save(s);
  return next;
}
