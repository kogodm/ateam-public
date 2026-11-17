import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store';
import { handleSyncApi } from './sync-api';
import { SyncStore } from './sync-store';

let dir: string;
let server: Server;
let base: string;
let store: Store;
const revoked: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-api-'));
  store = new Store(join(dir, 'store.json'));
  const sync = new SyncStore(join(dir, 'sync'));
  revoked.length = 0;
  server = createServer((req, res) => {
    void handleSyncApi(req, res, new URL(req.url ?? '/', 'http://x'), {
      store,
      sync,
      online: () => false,
      onRevoke: (id) => revoked.push(id),
      rateLimited: () => false,
      noteFailure: () => {},
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function device(email: string, name = 'mac'): { auth: string; id: string } {
  if (!store.hasUser(email)) store.addUser(email, 'hunter22');
  const d = store.addDevice(email, name);
  return { auth: `Bearer ${d.id}.${d.token}`, id: d.id };
}

async function call(
  auth: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

describe('/sync/api', () => {
  it('needs a live device token, and acts for that device’s account', async () => {
    expect((await call('Bearer nope', 'GET', '/sync/api/me')).status).toBe(401);
    const mac = device('a@x.com');
    const me = await call(mac.auth, 'GET', '/sync/api/me');
    expect(me.body).toMatchObject({ email: 'a@x.com', deviceId: mac.id, rev: 0 });
    expect(me.body.accountId).toBe(store.accountIdOf('a@x.com'));
  });

  it('two devices of one account share records; another account sees nothing', async () => {
    const mac = device('a@x.com', 'mac');
    const pc = device('a@x.com', 'pc');
    const stranger = device('b@y.com');
    const change = { type: 'task', key: 'k1', baseRev: 0, updatedAt: 1, data: 'ct' };
    expect(
      (await call(mac.auth, 'POST', '/sync/api/push', { changes: [change] })).body,
    ).toMatchObject({
      accepted: [{ key: 'k1', rev: 1 }],
      conflicts: [],
    });
    expect((await call(pc.auth, 'GET', '/sync/api/pull?since=0')).body).toMatchObject({
      entries: [{ key: 'k1', data: 'ct', deviceId: mac.id }],
      rev: 1,
      more: false,
    });
    expect((await call(stranger.auth, 'GET', '/sync/api/pull?since=0')).body).toMatchObject({
      entries: [],
      rev: 0,
    });
    const stale = await call(pc.auth, 'POST', '/sync/api/push', {
      changes: [{ ...change, data: 'pc' }],
    });
    expect(stale.body).toMatchObject({ accepted: [], conflicts: [{ key: 'k1', rev: 1 }] });
  });

  it('bad input is a 400, not a crash', async () => {
    const mac = device('a@x.com');
    expect((await call(mac.auth, 'POST', '/sync/api/push', '{not json')).status).toBe(400);
    expect(
      (await call(mac.auth, 'POST', '/sync/api/push', { changes: [{ type: 'X' }] })).status,
    ).toBe(400);
    expect((await call(mac.auth, 'GET', '/sync/api/pull?since=-1')).status).toBe(400);
    expect((await call(mac.auth, 'GET', '/sync/api/blobs/..%2Fstore.json')).status).toBe(400);
  });

  it('blobs: missing → upload → read back', async () => {
    const mac = device('a@x.com');
    const id = 'c'.repeat(64);
    expect((await call(mac.auth, 'POST', '/sync/api/blobs/missing', { ids: [id] })).body).toEqual({
      missing: [id],
    });
    const put = await fetch(`${base}/sync/api/blobs/${id}`, {
      method: 'PUT',
      headers: { authorization: mac.auth },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(await put.json()).toEqual({ stored: true });
    const got = await fetch(`${base}/sync/api/blobs/${id}`, {
      headers: { authorization: mac.auth },
    });
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([1, 2, 3]);
    expect((await call(mac.auth, 'GET', `/sync/api/blobs/${'d'.repeat(64)}`)).status).toBe(404);
  });

  it('key envelope: the loser of a race gets the winner’s envelope back', async () => {
    const mac = device('a@x.com', 'mac');
    const pc = device('a@x.com', 'pc');
    expect(
      (await call(mac.auth, 'PUT', '/sync/api/key', { envelope: { w: 1 }, ifVersion: 0 })).body,
    ).toEqual({
      version: 1,
    });
    const lost = await call(pc.auth, 'PUT', '/sync/api/key', { envelope: { w: 2 }, ifVersion: 0 });
    expect(lost).toMatchObject({ status: 409, body: { version: 1, envelope: { w: 1 } } });
    expect((await call(pc.auth, 'GET', '/sync/api/key')).body).toEqual({
      version: 1,
      envelope: { w: 1 },
    });
  });

  it('devices: list marks the caller; rename; revoke cuts the revoked device off', async () => {
    const mac = device('a@x.com', 'mac');
    const pc = device('a@x.com', 'pc');
    const list = await call(mac.auth, 'GET', '/sync/api/devices');
    expect(
      (list.body.devices as { id: string; current: boolean }[]).map((d) => [d.id, d.current]),
    ).toEqual([
      [mac.id, true],
      [pc.id, false],
    ]);
    expect(
      (await call(mac.auth, 'POST', '/sync/api/devices/rename', { id: pc.id, name: 'office' }))
        .status,
    ).toBe(200);
    expect(store.device(pc.id)?.name).toBe('office');
    const stranger = device('b@y.com');
    expect(
      (await call(stranger.auth, 'POST', '/sync/api/devices/revoke', { id: pc.id })).status,
    ).toBe(404);
    expect((await call(mac.auth, 'POST', '/sync/api/devices/revoke', { id: pc.id })).status).toBe(
      200,
    );
    expect(revoked).toEqual([pc.id]);
    expect((await call(pc.auth, 'GET', '/sync/api/me')).status).toBe(401);
  });
});
