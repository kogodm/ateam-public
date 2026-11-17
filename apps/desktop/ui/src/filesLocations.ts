import type { Rpc } from './rpc';

/**
 * User-added Files-panel locations, scoped PER PROJECT (the session cwd) so
 * one project's extra dirs never leak into another.
 *
 * These now live on the SERVER. They used to be in localStorage, which is per
 * browser: the desktop webview and a phone's Safari keep separate stores, so a
 * directory added at the desk simply was not there on the phone, with nothing
 * on screen to say why. A location is a property of the project, not of the
 * screen it was added from.
 *
 * The localStorage half is kept for one job only — migration. The first read
 * of a scope hands whatever that browser still has to the server, so the dirs
 * someone added at the desk survive the move and then appear everywhere.
 */
const legacyKey = (scope: string): string => `ateam.files.locations:${scope}`;

function readLegacy(scope: string): string[] {
  try {
    const raw = localStorage.getItem(legacyKey(scope));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function dropLegacy(scope: string): void {
  try {
    localStorage.removeItem(legacyKey(scope));
  } catch {
    /* private mode */
  }
}

export async function loadLocations(rpc: Rpc, scope: string): Promise<string[]> {
  if (!scope) return [];
  const server = (await rpc.request('files.locations', { scope })).locations;
  const legacy = readLegacy(scope);
  if (legacy.length === 0) return server;
  // migrate: union, server first so its order wins for dirs both sides know
  const merged = [...server];
  for (const d of legacy) if (!merged.includes(d)) merged.push(d);
  const saved = (await rpc.request('files.setLocations', { scope, locations: merged })).locations;
  dropLegacy(scope);
  return saved;
}

export async function saveLocations(rpc: Rpc, scope: string, list: string[]): Promise<string[]> {
  if (!scope) return [];
  return (await rpc.request('files.setLocations', { scope, locations: list })).locations;
}
