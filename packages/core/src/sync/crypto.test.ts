import { describe, expect, it } from 'vitest';
import {
  BadPassphrase,
  blobId,
  decryptBytes,
  decryptString,
  encryptBytes,
  encryptString,
  newDataKey,
  recordKey,
  unwrapDataKey,
  wrapDataKey,
} from './crypto';

describe('sync crypto', () => {
  it('the passphrase unwraps the data key; a wrong one is BadPassphrase', () => {
    const k = newDataKey();
    const env = wrapDataKey(k, 'correct horse 电池');
    expect(unwrapDataKey(env, 'correct horse 电池').equals(k)).toBe(true);
    expect(() => unwrapDataKey(env, 'wrong horse')).toThrow(BadPassphrase);
    expect(JSON.stringify(env)).not.toContain(k.toString('base64url'));
  });

  it('records and blobs round-trip, and tampering is detected', () => {
    const k = newDataKey();
    const data = encryptString(k, '{"任务":"写同步"}');
    expect(decryptString(k, data)).toBe('{"任务":"写同步"}');
    expect(encryptString(k, 'same')).not.toBe(encryptString(k, 'same')); // fresh iv
    const parts = data.split('.');
    const flipped = [parts[0], parts[1], parts[2], `A${(parts[3] ?? '').slice(1)}`].join('.');
    expect(() => decryptString(k, flipped)).toThrow();
    expect(() => decryptString(newDataKey(), data)).toThrow();
    const blob = encryptBytes(k, Buffer.from('# meta'));
    expect(decryptBytes(k, blob).toString()).toBe('# meta');
  });

  it('record keys and blob ids are stable per key and reveal nothing of the name', () => {
    const k = newDataKey();
    expect(recordKey(k, 'task', 't1')).toBe(recordKey(k, 'task', 't1'));
    expect(recordKey(k, 'task', 't1')).not.toBe(recordKey(k, 'human', 't1'));
    expect(recordKey(k, 'task', 't1')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(recordKey(newDataKey(), 'task', 't1')).not.toBe(recordKey(k, 'task', 't1'));
    expect(blobId(k, Buffer.from('x'))).toMatch(/^[0-9a-f]{64}$/);
  });
});
