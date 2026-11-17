import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store';

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-store-'));
  store = new Store(join(dir, 'store.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('relay store', () => {
  it('accounts: create, verify, no duplicates, case-insensitive email', () => {
    store.addUser('A@x.com', 'hunter22');
    expect(store.hasUser('a@x.com')).toBe(true);
    expect(store.verifyUser('a@X.com', 'hunter22')).toBe(true);
    expect(store.verifyUser('a@x.com', 'wrong')).toBe(false);
    expect(() => store.addUser('a@x.com', 'other')).toThrow();
  });

  it('devices: owned, token verified by hash, listed per owner, removable by owner only', () => {
    store.addUser('a@x.com', 'hunter22');
    store.addUser('b@y.com', 'hunter22');
    const d = store.addDevice('a@x.com', 'mac');
    expect(store.verifyDeviceToken(d.id, d.token)).toBe(true);
    expect(store.verifyDeviceToken(d.id, 'nope')).toBe(false);
    expect(store.devicesOf('a@x.com').map((x) => x.id)).toEqual([d.id]);
    expect(store.devicesOf('b@y.com')).toEqual([]);
    expect(store.removeDevice(d.id, 'b@y.com')).toBe(false);
    expect(store.removeDevice(d.id, 'a@x.com')).toBe(true);
  });

  it('persists across reopen', () => {
    store.addUser('a@x.com', 'hunter22');
    const d = store.addDevice('a@x.com', 'mac');
    const re = new Store(join(dir, 'store.json'));
    expect(re.verifyUser('a@x.com', 'hunter22')).toBe(true);
    expect(re.verifyDeviceToken(d.id, d.token)).toBe(true);
  });
});

describe('relay store — accounts and devices for sync', () => {
  it('every account gets a stable accountId, including ones created before sync', () => {
    const path = join(dir, 'old.json');
    writeFileSync(
      path,
      JSON.stringify({
        users: { 'a@x.com': { passHash: 'h', passSalt: 's', createdAt: 't' } },
        devices: {},
      }),
    );
    const id = new Store(path).accountIdOf('a@x.com');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Store(path).accountIdOf('A@x.com')).toBe(id);
    store.addUser('b@y.com', 'hunter22');
    expect(store.accountIdOf('b@y.com')).not.toBe(id);
  });

  it('the same installation signing in again reuses its device and rotates the token', () => {
    store.addUser('a@x.com', 'hunter22');
    const first = store.addDevice('a@x.com', 'mac', 'inst-1234-abcd');
    const again = store.addDevice('a@x.com', 'mac (renamed)', 'inst-1234-abcd');
    expect(again.id).toBe(first.id);
    expect(again.reused).toBe(true);
    expect(store.verifyDeviceToken(first.id, first.token)).toBe(false);
    expect(store.verifyDeviceToken(again.id, again.token)).toBe(true);
    expect(store.devicesOf('a@x.com')).toHaveLength(1);
    // another account, or no installation id, never reuses
    store.addUser('b@y.com', 'hunter22');
    expect(store.addDevice('b@y.com', 'mac', 'inst-1234-abcd').id).not.toBe(first.id);
    expect(store.addDevice('a@x.com', 'mac').id).not.toBe(first.id);
  });

  it('rename is owner-only and refuses an empty name', () => {
    store.addUser('a@x.com', 'hunter22');
    const d = store.addDevice('a@x.com', 'mac');
    expect(store.renameDevice(d.id, 'b@y.com', 'x')).toBe(false);
    expect(store.renameDevice(d.id, 'a@x.com', '   ')).toBe(false);
    expect(store.renameDevice(d.id, 'a@x.com', 'studio')).toBe(true);
    expect(store.device(d.id)?.name).toBe('studio');
  });
});
