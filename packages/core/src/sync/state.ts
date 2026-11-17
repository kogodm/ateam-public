import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ateamHome } from '../paths';

/**
 * What this device last agreed with the server, per record: the server
 * revision it is based on and the hash of its payload at that point. A local
 * payload whose hash differs is a local change; a remote entry newer than the
 * stored rev is a remote change. Also the pull cursor.
 */
export interface SyncItemState {
  /** server revision this device's copy is based on */
  rev: number;
  /** sha256 of the canonical payload as last synced */
  hash: string;
  /** server key (HMAC) — to recognise tombstones, which carry no payload */
  key: string;
  /** when this device first saw the current local change (ms) — the change's
   *  time for last-writer-wins; reset once it is pushed */
  dirtySince?: number;
  dirtyHash?: string;
}

export interface SyncState {
  /** the account this state belongs to; a different account starts over */
  accountId: string;
  /** pull cursor: everything up to this server revision has been seen */
  rev: number;
  /** keyed by `<type>:<localId>` */
  items: Record<string, SyncItemState>;
  lastSyncAt?: string;
}

const statePath = (): string => join(ateamHome(), 'sync', 'state.json');

export function loadSyncState(accountId: string): SyncState {
  try {
    if (existsSync(statePath())) {
      const s = JSON.parse(readFileSync(statePath(), 'utf8')) as SyncState;
      if (s.accountId === accountId && s.items) return s;
    }
  } catch {
    /* unreadable → start over; the server copy is the truth */
  }
  return { accountId, rev: 0, items: {} };
}

export function saveSyncState(s: SyncState): void {
  mkdirSync(join(ateamHome(), 'sync'), { recursive: true, mode: 0o700 });
  const tmp = `${statePath()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s)}\n`, { mode: 0o600 });
  renameSync(tmp, statePath());
}
