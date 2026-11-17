import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../../../packages/core/src/config';
import { listHumans } from '../../../packages/core/src/humans';
import { relaySyncApi } from '../../../packages/core/src/sync/relay-http';
import { SyncService } from '../../../packages/core/src/sync/service';
import { Store } from './store';
import { handleSyncApi } from './sync-api';
import { SyncStore } from './sync-store';

/** Settings → Sync end to end: the desktop SyncService against this relay. */
let root: string;
let server: Server;
let base: string;
let relayStore: Store;
const prev = { home: process.env.ATEAM_HOME, ks: process.env.ATEAM_SYNC_KEYSTORE };
const HUMAN = '22222222-aaaa-4bbb-8ccc-000000000002';

type Dev = { home: string; svc: SyncService; id: string };
const devs: Record<string, Dev> = {};

async function on<T>(name: string, fn: (d: Dev) => Promise<T> | T): Promise<T> {
  const d = devs[name] as Dev;
  process.env.ATEAM_HOME = d.home;
  return fn(d);
}

function device(name: string): Dev {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  const reg = relayStore.addDevice('me@x.com', name);
  process.env.ATEAM_HOME = home;
  const cfg = loadConfig();
  saveConfig({
    ...cfg,
    remote: {
      ...cfg.remote,
      enabled: true,
      url: 'wss://relay.test:1',
      deviceId: reg.id,
      token: reg.token,
      name,
    },
  });
  const svc = new SyncService({
    api: (ep) => relaySyncApi({ baseUrl: base, deviceId: ep.deviceId, token: ep.token }),
  });
  const d = { home, svc, id: reg.id };
  devs[name] = d;
  return d;
}

beforeAll(async () => {
  process.env.ATEAM_SYNC_KEYSTORE = 'file';
  root = mkdtempSync(join(tmpdir(), 'ateam-sync-svc-'));
  relayStore = new Store(join(root, 'relay-store.json'));
  const sync = new SyncStore(join(root, 'relay-sync'));
  server = createServer((req, res) => {
    void handleSyncApi(req, res, new URL(req.url ?? '/', 'http://x'), {
      store: relayStore,
      sync,
      online: () => false,
      onRevoke: () => {},
      rateLimited: () => false,
      noteFailure: () => {},
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  relayStore.addUser('me@x.com', 'hunter222');
});

afterAll(async () => {
  for (const d of Object.values(devs)) d.svc.shutdown();
  process.env.ATEAM_HOME = prev.home;
  if (prev.ks === undefined) delete process.env.ATEAM_SYNC_KEYSTORE;
  else process.env.ATEAM_SYNC_KEYSTORE = prev.ks;
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

describe('SyncService', () => {
  it('needs a relay sign-in', async () => {
    const home = join(root, 'nobody');
    mkdirSync(home, { recursive: true });
    process.env.ATEAM_HOME = home;
    await expect(new SyncService().enable('whatever1')).rejects.toMatchObject({
      code: 'not_signed_in',
    });
  });

  it('the first device creates the key, marks its projects and pushes', async () => {
    const a = device('mac');
    const project = join(root, 'work', 'app');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(a.home, 'humans.json'),
      JSON.stringify({
        humans: [
          {
            id: HUMAN,
            name: 'Weber',
            role: 'coder',
            createdAt: '2026-09-01T00:00:00Z',
            projects: [
              {
                dir: project,
                key: 'app',
                name: 'app',
                firstSeen: '2026-09-01',
                lastSeen: '2026-09-10',
              },
            ],
          },
        ],
      }),
    );
    const st = await on('mac', (d) => d.svc.enable('correct horse'));
    expect(st).toMatchObject({ enabled: true, unlocked: true, email: 'me@x.com', syncing: false });
    expect(st.lastError).toBeUndefined();
    expect(st.lastPushed).toBeGreaterThan(0);
    expect(existsSync(join(project, '.ateam', 'project.json'))).toBe(true);
    await on('mac', () => {
      expect(loadConfig().remote.accountId).toBe(relayStore.accountIdOf('me@x.com'));
      expect(listHumans()[0]?.projects[0]?.projectId).toMatch(/^prj_/);
    });
  });

  it('another device: a wrong passphrase changes nothing, the right one pulls', async () => {
    device('pc');
    await expect(on('pc', (d) => d.svc.enable('wrong horse'))).rejects.toMatchObject({
      code: 'bad_passphrase',
    });
    await on('pc', () => expect(loadConfig().sync.enabled).toBe(false));
    const st = await on('pc', (d) => d.svc.enable('correct horse'));
    expect(st).toMatchObject({ enabled: true, unlocked: true });
    await on('pc', () => expect(listHumans().map((h) => h.name)).toEqual(['Weber']));
  });

  it('a passphrase change keeps existing devices working and gates new ones', async () => {
    await on('mac', (d) => d.svc.changePassphrase('correct horse', 'battery staple'));
    await expect(
      on('mac', (d) => d.svc.changePassphrase('correct horse', 'x2345678')),
    ).rejects.toMatchObject({
      code: 'bad_passphrase',
    });
    expect((await on('pc', (d) => d.svc.now())).lastError).toBeUndefined();
    device('laptop');
    await expect(on('laptop', (d) => d.svc.enable('correct horse'))).rejects.toMatchObject({
      code: 'bad_passphrase',
    });
    expect(await on('laptop', (d) => d.svc.enable('battery staple'))).toMatchObject({
      unlocked: true,
    });
  });

  it('devices: list, rename; a revoked device sees why it stopped; revoking itself signs out', async () => {
    const list = await on('mac', (d) => d.svc.devices());
    expect(list.map((x) => x.name).sort()).toEqual(['laptop', 'mac', 'pc']);
    await on('mac', (d) => d.svc.renameDevice((devs.pc as Dev).id, 'office pc'));
    await on('mac', (d) => d.svc.revokeDevice((devs.pc as Dev).id));
    expect((await on('pc', (d) => d.svc.now())).lastError).toMatch(/no longer signed in/);
    await on('laptop', (d) => d.svc.revokeDevice(d.id));
    await on('laptop', () => {
      const c = loadConfig();
      expect(c.sync.enabled).toBe(false);
      expect(c.remote).toMatchObject({ deviceId: '', token: '', enabled: false });
    });
  });
});
