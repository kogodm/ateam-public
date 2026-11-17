import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Per-account sync storage. The relay only ever holds CIPHERTEXT: record keys
 * and blob ids are HMACs chosen by the client, `data` is an opaque base64
 * string, the key envelope is the data key wrapped by the user's passphrase.
 * The server can order, dedupe and bound what it stores — nothing more.
 *
 *   <root>/<accountId>/log.jsonl   append-only revisions (latest per key wins)
 *   <root>/<accountId>/blobs/<id>  file bodies, content-addressed by the client
 *   <root>/<accountId>/key.json    { version, envelope, updatedAt }
 *
 * Conflicts are detected here and resolved by the client (it can read the
 * content; we cannot): a change whose `baseRev` is older than the key's
 * current revision is refused and the current entry handed back.
 */

export interface SyncEntry {
  rev: number;
  type: string;
  key: string;
  /** client clock (ms) — used by the client for last-writer-wins */
  updatedAt: number;
  deviceId: string;
  deleted?: boolean;
  data?: string;
}

export interface SyncChange {
  type: string;
  key: string;
  /** the revision this edit was made from; 0 = the client has never seen it */
  baseRev: number;
  updatedAt: number;
  deleted?: boolean;
  data?: string;
}

export interface SyncLimits {
  /** one record's `data` (chars) */
  maxRecordBytes: number;
  /** one blob */
  maxBlobBytes: number;
  /** records + blobs per account */
  maxAccountBytes: number;
}

export const DEFAULT_SYNC_LIMITS: SyncLimits = {
  maxRecordBytes: 1024 * 1024,
  maxBlobBytes: 16 * 1024 * 1024,
  maxAccountBytes: 1024 * 1024 * 1024,
};

/** thrown for input the client must fix (HTTP 400) or a full account (413) */
export class SyncError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

const TYPE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
const BLOB_RE = /^[0-9a-f]{64}$/;
const ACCOUNT_RE = /^[0-9a-f-]{36}$/;
const MAX_ENVELOPE_CHARS = 8192;

export const isBlobId = (id: string): boolean => BLOB_RE.test(id);

export class SyncStore {
  private readonly accounts = new Map<string, AccountLog>();
  constructor(
    private readonly root: string,
    private readonly limits: SyncLimits = DEFAULT_SYNC_LIMITS,
  ) {}

  account(accountId: string): AccountLog {
    if (!ACCOUNT_RE.test(accountId)) throw new Error(`bad account id ${accountId}`);
    let a = this.accounts.get(accountId);
    if (!a) {
      a = new AccountLog(join(this.root, accountId), this.limits);
      this.accounts.set(accountId, a);
    }
    return a;
  }
}

export class AccountLog {
  private readonly latest = new Map<string, SyncEntry>();
  private head = 0;
  private recordBytes = 0;
  private blobBytes = 0;
  private readonly logPath: string;
  private readonly blobDir: string;
  private readonly keyPath: string;

  constructor(
    dir: string,
    private readonly limits: SyncLimits,
  ) {
    this.logPath = join(dir, 'log.jsonl');
    this.blobDir = join(dir, 'blobs');
    this.keyPath = join(dir, 'key.json');
    mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    this.load();
  }

  get rev(): number {
    return this.head;
  }

  get usedBytes(): number {
    return this.recordBytes + this.blobBytes;
  }

  private load(): void {
    let lines = 0;
    if (existsSync(this.logPath)) {
      for (const line of readFileSync(this.logPath, 'utf8').split('\n')) {
        if (!line) continue;
        let e: SyncEntry;
        try {
          e = JSON.parse(line) as SyncEntry;
        } catch {
          continue; // a crash mid-append leaves a torn last line — skip it
        }
        lines++;
        this.index(e);
      }
    }
    for (const f of readdirSync(this.blobDir)) {
      if (isBlobId(f)) this.blobBytes += statSync(join(this.blobDir, f)).size;
    }
    // superseded revisions are dead weight — rewrite once they dominate
    if (lines > this.latest.size * 2 + 100) this.compact();
  }

  private index(e: SyncEntry): void {
    const k = `${e.type}\0${e.key}`;
    this.recordBytes -= this.latest.get(k)?.data?.length ?? 0;
    this.recordBytes += e.data?.length ?? 0;
    this.latest.set(k, e);
    if (e.rev > this.head) this.head = e.rev;
  }

  private compact(): void {
    const body = [...this.latest.values()]
      .sort((a, b) => a.rev - b.rev)
      .map((e) => `${JSON.stringify(e)}\n`)
      .join('');
    const tmp = `${this.logPath}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, this.logPath);
  }

  current(type: string, key: string): SyncEntry | undefined {
    return this.latest.get(`${type}\0${key}`);
  }

  /** apply what does not conflict; hand back the current entry for what does */
  push(
    deviceId: string,
    changes: SyncChange[],
  ): {
    accepted: { type: string; key: string; rev: number }[];
    conflicts: SyncEntry[];
    rev: number;
  } {
    validateChanges(changes, this.limits);
    const fresh = changes.filter((c) => {
      const cur = this.current(c.type, c.key);
      return !cur || cur.rev <= c.baseRev;
    });
    const conflicts = changes
      .filter((c) => !fresh.includes(c))
      .map((c) => this.current(c.type, c.key) as SyncEntry);
    const growth = fresh.reduce(
      (n, c) =>
        n +
        (c.deleted ? 0 : (c.data?.length ?? 0)) -
        (this.current(c.type, c.key)?.data?.length ?? 0),
      0,
    );
    if (growth > 0 && this.usedBytes + growth > this.limits.maxAccountBytes)
      throw new SyncError(413, 'sync storage quota exceeded');
    const entries: SyncEntry[] = fresh.map((c, i) => ({
      rev: this.head + i + 1,
      type: c.type,
      key: c.key,
      updatedAt: c.updatedAt,
      deviceId,
      ...(c.deleted ? { deleted: true } : { data: c.data }),
    }));
    if (entries.length) {
      appendFileSync(this.logPath, entries.map((e) => `${JSON.stringify(e)}\n`).join(''), {
        mode: 0o600,
      });
      for (const e of entries) this.index(e);
    }
    return {
      accepted: entries.map((e) => ({ type: e.type, key: e.key, rev: e.rev })),
      conflicts,
      rev: this.head,
    };
  }

  /** the latest entry of every key changed after `since`, oldest first */
  pull(since: number, limit: number): { entries: SyncEntry[]; rev: number; more: boolean } {
    const newer = [...this.latest.values()]
      .filter((e) => e.rev > since)
      .sort((a, b) => a.rev - b.rev);
    const entries = newer.slice(0, limit);
    return { entries, rev: this.head, more: newer.length > entries.length };
  }

  hasBlob(id: string): boolean {
    return isBlobId(id) && existsSync(join(this.blobDir, id));
  }

  missingBlobs(ids: string[]): string[] {
    return ids.filter((id) => isBlobId(id) && !this.hasBlob(id));
  }

  readBlob(id: string): Buffer {
    if (!this.hasBlob(id)) throw new SyncError(404, 'no such blob');
    return readFileSync(join(this.blobDir, id));
  }

  /** content-addressed: a blob that already exists is left untouched */
  putBlob(id: string, body: Buffer): { stored: boolean } {
    if (!isBlobId(id)) throw new SyncError(400, 'blob id must be 64 hex chars');
    if (this.hasBlob(id)) return { stored: false };
    if (body.length > this.limits.maxBlobBytes) throw new SyncError(413, 'blob too large');
    if (this.usedBytes + body.length > this.limits.maxAccountBytes)
      throw new SyncError(413, 'sync storage quota exceeded');
    const path = join(this.blobDir, id);
    writeFileSync(`${path}.tmp`, body, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    this.blobBytes += body.length;
    return { stored: true };
  }

  /** the data key, wrapped by the passphrase — opaque to us */
  getKey(): { version: number; envelope: unknown } {
    if (!existsSync(this.keyPath)) return { version: 0, envelope: null };
    const k = JSON.parse(readFileSync(this.keyPath, 'utf8')) as {
      version: number;
      envelope: unknown;
    };
    return { version: k.version, envelope: k.envelope };
  }

  /** compare-and-set on `ifVersion`, so two devices enabling sync at the same
   *  moment cannot each install their own data key */
  putKey(envelope: unknown, ifVersion: number): { version: number } {
    if (!envelope || typeof envelope !== 'object')
      throw new SyncError(400, 'envelope must be an object');
    if (JSON.stringify(envelope).length > MAX_ENVELOPE_CHARS)
      throw new SyncError(400, 'envelope too large');
    const cur = this.getKey();
    if (cur.version !== ifVersion) throw new SyncError(409, 'key changed on another device');
    const version = cur.version + 1;
    const tmp = `${this.keyPath}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ version, envelope, updatedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    renameSync(tmp, this.keyPath);
    return { version };
  }
}

function validateChanges(changes: unknown, limits: SyncLimits): asserts changes is SyncChange[] {
  if (!Array.isArray(changes)) throw new SyncError(400, 'changes must be an array');
  const seen = new Set<string>();
  for (const c of changes as Partial<SyncChange>[]) {
    if (!c || typeof c.type !== 'string' || !TYPE_RE.test(c.type))
      throw new SyncError(400, 'change.type must match [a-z][a-z0-9_-]{0,31}');
    if (typeof c.key !== 'string' || !KEY_RE.test(c.key))
      throw new SyncError(400, 'change.key must be 1-128 base64url chars');
    if (!Number.isInteger(c.baseRev) || (c.baseRev as number) < 0)
      throw new SyncError(400, 'change.baseRev must be a non-negative integer');
    if (!Number.isFinite(c.updatedAt))
      throw new SyncError(400, 'change.updatedAt must be a number');
    if (c.deleted !== undefined && c.deleted !== true)
      throw new SyncError(400, 'change.deleted must be true or absent');
    if (!c.deleted && typeof c.data !== 'string')
      throw new SyncError(400, 'change.data must be a string unless deleted');
    if (!c.deleted && (c.data as string).length > limits.maxRecordBytes)
      throw new SyncError(413, 'record too large');
    const k = `${c.type}\0${c.key}`;
    if (seen.has(k)) throw new SyncError(400, 'a key may appear once per push');
    seen.add(k);
  }
}
