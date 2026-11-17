import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SyncChange, SyncStore } from './sync-store';

const ACCT = '11111111-2222-3333-4444-555555555555';
const BLOB = 'a'.repeat(64);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-sync-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ch = (key: string, baseRev: number, data = `ct-${key}`, extra: Partial<SyncChange> = {}) => ({
  type: 'task',
  key,
  baseRev,
  updatedAt: 1000,
  data,
  ...extra,
});

describe('sync store', () => {
  it('push assigns monotonic revs; pull returns the latest entry per key after `since`', () => {
    const a = new SyncStore(dir).account(ACCT);
    expect(a.push('dev1', [ch('k1', 0), ch('k2', 0)]).accepted.map((x) => x.rev)).toEqual([1, 2]);
    expect(a.push('dev1', [ch('k1', 1, 'ct-k1-v2')]).rev).toBe(3);
    const all = a.pull(0, 100);
    expect(all.entries.map((e) => [e.key, e.rev, e.data])).toEqual([
      ['k2', 2, 'ct-k2'],
      ['k1', 3, 'ct-k1-v2'],
    ]);
    expect(a.pull(2, 100).entries.map((e) => e.key)).toEqual(['k1']);
    expect(a.pull(0, 1)).toMatchObject({ more: true, rev: 3 });
  });

  it('a change made from an older revision is refused and the current entry handed back', () => {
    const a = new SyncStore(dir).account(ACCT);
    a.push('dev1', [ch('k1', 0)]);
    a.push('dev1', [ch('k1', 1, 'from-dev1')]);
    const r = a.push('dev2', [ch('k1', 1, 'from-dev2'), ch('k9', 0)]);
    expect(r.accepted.map((x) => x.key)).toEqual(['k9']);
    expect(r.conflicts).toMatchObject([{ key: 'k1', rev: 2, data: 'from-dev1', deviceId: 'dev1' }]);
    // a brand-new key pushed by two devices: the second one conflicts too
    expect(a.push('dev2', [ch('k9', 0, 'again')]).conflicts).toHaveLength(1);
  });

  it('deletes are tombstones that pull still returns', () => {
    const a = new SyncStore(dir).account(ACCT);
    a.push('dev1', [ch('k1', 0)]);
    a.push('dev1', [{ type: 'task', key: 'k1', baseRev: 1, updatedAt: 2, deleted: true }]);
    expect(a.pull(0, 10).entries).toMatchObject([{ key: 'k1', rev: 2, deleted: true }]);
    expect(a.pull(0, 10).entries[0]?.data).toBeUndefined();
  });

  it('survives a reopen, skips a torn last line, and compacts superseded revisions', () => {
    const s1 = new SyncStore(dir).account(ACCT);
    s1.push('dev1', [ch('k1', 0)]);
    for (let i = 1; i <= 150; i++) s1.push('dev1', [ch('k1', i, `v${i}`)]);
    appendFileSync(join(dir, ACCT, 'log.jsonl'), '{"rev":999,"ty');
    const s2 = new SyncStore(dir).account(ACCT);
    expect(s2.rev).toBe(151);
    expect(s2.pull(0, 10).entries).toMatchObject([{ key: 'k1', data: 'v150' }]);
    expect(
      readFileSync(join(dir, ACCT, 'log.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
    expect(s2.push('dev1', [ch('k1', 151, 'next')]).rev).toBe(152);
  });

  it('rejects malformed changes before applying any of them', () => {
    const a = new SyncStore(dir).account(ACCT);
    expect(() => a.push('d', [ch('ok', 0), ch('bad key!', 0)])).toThrow(/key/);
    expect(() => a.push('d', [ch('k', 0), ch('k', 0)])).toThrow(/once/);
    expect(() => a.push('d', [{ ...ch('k', 0), data: undefined }])).toThrow(/data/);
    expect(a.rev).toBe(0);
  });

  it('enforces record, blob and account quotas', () => {
    const limits = { maxRecordBytes: 10, maxBlobBytes: 8, maxAccountBytes: 20 };
    const a = new SyncStore(dir, limits).account(ACCT);
    expect(() => a.push('d', [ch('k', 0, 'x'.repeat(11))])).toThrow(/record too large/);
    a.push('d', [ch('k1', 0, 'x'.repeat(10))]);
    expect(() => a.putBlob(BLOB, Buffer.alloc(9))).toThrow(/blob too large/);
    a.putBlob(BLOB, Buffer.alloc(8));
    expect(() => a.push('d', [ch('k2', 0, 'x'.repeat(3))])).toThrow(/quota/);
    // replacing a record with a smaller one is always allowed
    expect(a.push('d', [ch('k1', 1, 'x')]).accepted).toHaveLength(1);
  });

  it('blobs are write-once by id and reported missing until uploaded', () => {
    const a = new SyncStore(dir).account(ACCT);
    const other = 'b'.repeat(64);
    expect(a.missingBlobs([BLOB, other, 'nothex'])).toEqual([BLOB, other]);
    expect(a.putBlob(BLOB, Buffer.from('one'))).toEqual({ stored: true });
    expect(a.putBlob(BLOB, Buffer.from('two'))).toEqual({ stored: false });
    expect(a.readBlob(BLOB).toString()).toBe('one');
    expect(a.missingBlobs([BLOB, other])).toEqual([other]);
    expect(new SyncStore(dir).account(ACCT).usedBytes).toBe(3);
  });

  it('the wrapped key is compare-and-set on its version', () => {
    const a = new SyncStore(dir).account(ACCT);
    expect(a.getKey()).toEqual({ version: 0, envelope: null });
    expect(a.putKey({ w: 'first' }, 0)).toEqual({ version: 1 });
    expect(() => a.putKey({ w: 'racer' }, 0)).toThrow(/another device/);
    expect(a.putKey({ w: 'rewrapped' }, 1)).toEqual({ version: 2 });
    expect(new SyncStore(dir).account(ACCT).getKey()).toEqual({
      version: 2,
      envelope: { w: 'rewrapped' },
    });
  });

  it('refuses an account id that could escape the sync dir', () => {
    expect(() => new SyncStore(dir).account('../etc')).toThrow();
  });
});
