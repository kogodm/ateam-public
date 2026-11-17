import {
  blobId,
  decryptBytes,
  decryptString,
  encryptBytes,
  encryptString,
  recordKey,
  sha256,
} from './crypto';
import type { SyncApi, SyncChange, SyncEntry } from './relay-http';
import {
  type LocalRecord,
  applyRemote,
  canonical,
  collectLocal,
  conflictCopyId,
  lk,
  removeLocal,
  writeMetaFile,
} from './snapshot';
import { type SyncItemState, type SyncState, loadSyncState, saveSyncState } from './state';

/**
 * One sync pass: pull what other devices changed, reconcile it with what this
 * device changed, push the rest. Rules: docs/sync/client.md.
 *
 * What travels is `{t, id, updatedAt, payload}` encrypted with the data key;
 * the server sees only the record type, an HMAC key and revision numbers.
 */

export interface PassDeps {
  api: SyncApi;
  key: Buffer;
  accountId: string;
  deviceId: string;
  /** used in conflict copy names */
  deviceName: string;
  now?: () => number;
}

export interface PassResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  /** records that could not be read (wrong key, damaged) — skipped */
  unreadable: number;
}

interface Plain {
  t: string;
  id: string;
  updatedAt: number;
  payload: Record<string, unknown>;
}

const PULL_PAGE = 500;
const PUSH_BATCH = 200;

export async function syncPass(d: PassDeps): Promise<PassResult> {
  const now = d.now ?? Date.now;
  const state = loadSyncState(d.accountId);
  const result: PassResult = { pushed: 0, pulled: 0, conflicts: 0, unreadable: 0 };
  const blobIdOf = (b: Buffer): string => blobId(d.key, b);

  let local = collectLocal(blobIdOf);
  markDirty(state, local, now());

  // ── pull ──
  for (let guard = 0; guard < 10_000; guard++) {
    const page = await d.api.pull(state.rev, PULL_PAGE);
    for (const e of page.entries) await absorb(d, state, local, e, result);
    state.rev = page.more ? (page.entries.at(-1)?.rev ?? page.rev) : Math.max(state.rev, page.rev);
    saveSyncState(state);
    if (!page.more) break;
  }

  // ── push ──
  local = collectLocal(blobIdOf);
  markDirty(state, local, now());
  const changes: { change: SyncChange; lkey: string; hash: string }[] = [];
  const blobs = new Map<string, Buffer>();
  for (const [lkey, r] of local) {
    const st = state.items[lkey];
    if (st && st.hash === r.hash) continue;
    const updatedAt = st?.dirtySince ?? now();
    const plain: Plain = { t: r.type, id: r.localId, updatedAt, payload: r.payload };
    if (r.type === 'file' && r.content) blobs.set(String(r.payload.blob), r.content);
    changes.push({
      lkey,
      hash: r.hash,
      change: {
        type: r.type,
        key: recordKey(d.key, r.type, r.localId),
        baseRev: st?.rev ?? 0,
        updatedAt,
        data: encryptString(d.key, JSON.stringify(plain)),
      },
    });
  }
  for (const [lkey, st] of Object.entries(state.items)) {
    if (local.has(lkey)) continue;
    if (!st.hash) {
      // created and removed again between passes: the server never had it
      if (st.rev === 0) delete state.items[lkey];
      continue;
    }
    changes.push({
      lkey,
      hash: '',
      change: {
        type: lkey.slice(0, lkey.indexOf(':')),
        key: st.key,
        baseRev: st.rev,
        updatedAt: now(),
        deleted: true,
      },
    });
  }

  if (blobs.size) {
    const missing = await d.api.missingBlobs([...blobs.keys()]);
    for (const id of missing) await d.api.putBlob(id, encryptBytes(d.key, blobs.get(id) as Buffer));
  }

  for (let i = 0; i < changes.length; i += PUSH_BATCH) {
    const batch = changes.slice(i, i + PUSH_BATCH);
    const res = await d.api.push(batch.map((c) => c.change));
    const byKey = new Map(batch.map((c) => [`${c.change.type}\0${c.change.key}`, c]));
    for (const a of res.accepted) {
      const c = byKey.get(`${a.type}\0${a.key}`);
      if (!c) continue;
      result.pushed++;
      if (c.change.deleted) delete state.items[c.lkey];
      else state.items[c.lkey] = { rev: a.rev, hash: c.hash, key: c.change.key };
    }
    // someone else changed these first: reconcile now, push again next pass
    for (const e of res.conflicts) await absorb(d, state, local, e, result);
    saveSyncState(state);
  }

  state.lastSyncAt = new Date(now()).toISOString();
  saveSyncState(state);
  return result;
}

/** note when each pending local change was first seen — its LWW timestamp */
function markDirty(state: SyncState, local: Map<string, LocalRecord>, at: number): void {
  for (const [lkey, r] of local) {
    const st = state.items[lkey];
    if (st?.hash === r.hash) continue;
    const key = st?.key ?? '';
    if (st?.dirtyHash === r.hash) continue;
    state.items[lkey] = {
      rev: st?.rev ?? 0,
      hash: st?.hash ?? '',
      key,
      dirtySince: r.updatedAt || at,
      dirtyHash: r.hash,
    };
  }
}

async function absorb(
  d: PassDeps,
  state: SyncState,
  local: Map<string, LocalRecord>,
  e: SyncEntry,
  result: PassResult,
): Promise<void> {
  let lkey: string | undefined;
  let plain: Plain | undefined;
  if (e.deleted) {
    lkey = Object.entries(state.items).find(([, s]) => s.key === e.key)?.[0];
    if (!lkey) return; // a record this device never had
  } else {
    try {
      plain = JSON.parse(decryptString(d.key, e.data ?? '')) as Plain;
      lkey = lk(plain.t, plain.id);
      if (e.key !== recordKey(d.key, plain.t, plain.id)) throw new Error('key mismatch');
    } catch {
      result.unreadable++;
      return;
    }
  }
  const st: SyncItemState | undefined = state.items[lkey];
  if (st && st.rev >= e.rev) return; // already based on this (e.g. our own push)
  const loc = local.get(lkey);
  const type = lkey.slice(0, lkey.indexOf(':'));
  const localId = lkey.slice(lkey.indexOf(':') + 1);
  const synced = !!st?.hash;
  const localChanged = loc ? !synced || loc.hash !== st?.hash : synced;

  if (e.deleted) {
    if (!localChanged && loc) {
      removeLocal(type, localId);
      if (type === 'human') {
        // never deleted here: push it back so the account keeps it
        state.items[lkey] = { rev: e.rev, hash: '', key: e.key };
        return;
      }
      delete state.items[lkey];
      result.pulled++;
      return;
    }
    // changed here meanwhile: keep it, and push it over the tombstone
    state.items[lkey] = { ...(st ?? { hash: '' }), rev: e.rev, key: e.key };
    if (loc) result.conflicts++;
    return;
  }

  const p = plain as Plain;
  const remoteHash = sha256(canonical(p.payload));
  const content = type === 'file' ? await fetchBlob(d, p.payload) : undefined;

  if (loc && loc.hash === remoteHash) {
    state.items[lkey] = { rev: e.rev, hash: remoteHash, key: e.key };
    return; // both sides arrived at the same thing
  }
  if (!localChanged) {
    if (type === 'file' && !content) return; // blob missing — try again next pass
    applyRemote(type, localId, p.payload, p.updatedAt, content);
    state.items[lkey] = { rev: e.rev, hash: remoteHash, key: e.key };
    result.pulled++;
    return;
  }

  // both changed: newer wins; a file's loser survives as a conflict copy
  result.conflicts++;
  const localAt = st?.dirtySince ?? loc?.updatedAt ?? 0;
  const remoteWins = p.updatedAt > localAt || (p.updatedAt === localAt && e.deviceId > d.deviceId);
  if (type === 'file' && content && loc?.content) {
    if (remoteWins) {
      writeMetaFile(conflictCopyId(localId, d.deviceName), loc.content, loc.updatedAt);
      applyRemote(type, localId, p.payload, p.updatedAt, content);
      state.items[lkey] = { rev: e.rev, hash: remoteHash, key: e.key };
    } else {
      writeMetaFile(conflictCopyId(localId, e.deviceId), content, p.updatedAt);
      state.items[lkey] = { ...(st as SyncItemState), rev: e.rev, key: e.key };
    }
    return;
  }
  if (remoteWins && (type !== 'file' || content)) {
    applyRemote(type, localId, p.payload, p.updatedAt, content);
    state.items[lkey] = { rev: e.rev, hash: remoteHash, key: e.key };
  } else {
    state.items[lkey] = { ...(st ?? { hash: '' }), rev: e.rev, key: e.key };
  }
}

async function fetchBlob(
  d: PassDeps,
  payload: Record<string, unknown>,
): Promise<Buffer | undefined> {
  const id = String(payload.blob ?? '');
  if (!/^[0-9a-f]{64}$/.test(id)) return undefined;
  try {
    const plain = decryptBytes(d.key, await d.api.getBlob(id));
    return blobId(d.key, plain) === id ? plain : undefined;
  } catch {
    return undefined;
  }
}
