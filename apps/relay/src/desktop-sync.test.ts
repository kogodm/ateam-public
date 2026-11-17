import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { humanMetaDir } from '../../../packages/core/src/human-meta';
import { listHumans } from '../../../packages/core/src/humans';
import { newDataKey } from '../../../packages/core/src/sync/crypto';
import { syncPass } from '../../../packages/core/src/sync/engine';
import { relaySyncApi } from '../../../packages/core/src/sync/relay-http';
import { allTasks, removeTask, updateTask } from '../../../packages/core/src/tasks';
import { Store } from './store';
import { handleSyncApi } from './sync-api';
import { SyncStore } from './sync-store';

/**
 * The desktop sync engine (packages/core/src/sync) — two devices of one account against this relay's real sync API (in-process,
 * plain HTTP). Each device is its own ATEAM_HOME; the test switches between
 * them, so every pass runs as exactly one device.
 */
let root: string;
let server: Server;
let base: string;
let relayStore: Store;
const key = newDataKey();
const prevHome = process.env.ATEAM_HOME;
const HUMAN = '11111111-aaaa-4bbb-8ccc-000000000001';

type Dev = { home: string; deviceId: string; token: string; name: string };
let A: Dev;
let B: Dev;

function as<T>(dev: Dev, fn: () => T): T {
  process.env.ATEAM_HOME = dev.home;
  return fn();
}
async function pass(dev: Dev) {
  process.env.ATEAM_HOME = dev.home;
  return syncPass({
    api: relaySyncApi({ baseUrl: base, deviceId: dev.deviceId, token: dev.token }),
    key,
    accountId: relayStore.accountIdOf('me@x.com') as string,
    deviceId: dev.deviceId,
    deviceName: dev.name,
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ateam-sync-e2e-'));
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
  const mk = (name: string): Dev => {
    const d = relayStore.addDevice('me@x.com', name);
    const home = join(root, name);
    mkdirSync(home, { recursive: true });
    return { home, deviceId: d.id, token: d.token, name };
  };
  A = mk('mac');
  B = mk('pc');
  // device A has a teammate with a project, a task, knowledge and a prompt override
  writeFileSync(
    join(A.home, 'humans.json'),
    JSON.stringify({
      humans: [
        {
          id: HUMAN,
          name: 'Weber',
          role: 'coder',
          model: 'sonnet',
          createdAt: '2026-09-01T00:00:00Z',
          projects: [
            {
              dir: '/work/app',
              key: 'app',
              name: 'app',
              firstSeen: '2026-09-01',
              lastSeen: '2026-09-10',
              projectId: 'prj_one',
            },
            {
              dir: '/work/scratch',
              key: 'scratch',
              name: 'scratch',
              firstSeen: '2026-09-02',
              lastSeen: '2026-09-02',
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    join(A.home, 'tasks.json'),
    JSON.stringify({
      tasks: [
        {
          id: 't1',
          title: '机密任务标题',
          status: 'open',
          project: '/work/app',
          projectId: 'prj_one',
          source: 'user',
          createdAt: 1,
          sessionId: 'local-only',
        },
      ],
    }),
  );
  const meta = as(A, () => humanMetaDir(HUMAN));
  mkdirSync(join(meta, 'knowledge'), { recursive: true });
  writeFileSync(join(meta, 'meta.md'), '# index v1\n');
  writeFileSync(join(meta, 'knowledge', 'sync.md'), 'relay has no ssh\n');
  mkdirSync(join(A.home, 'prompts'), { recursive: true });
  writeFileSync(join(A.home, 'prompts', 'handoff.txt'), 'my handoff prompt {{META_DIR}}');
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.ATEAM_HOME;
  else process.env.ATEAM_HOME = prevHome;
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

describe('sync between two devices', () => {
  it('a first pass pushes everything; the relay never sees plaintext', async () => {
    const r = await pass(A);
    expect(r.pushed).toBe(5); // human, task, 2 files, prompt
    const onServer = readdirSync(join(root, 'relay-sync'))
      .map((acct) => readFileSync(join(root, 'relay-sync', acct, 'log.jsonl'), 'utf8'))
      .join('');
    for (const secret of ['机密任务标题', 'Weber', 'relay has no ssh', 'handoff', 'prj_one', HUMAN])
      expect(onServer).not.toContain(secret);
    expect((await pass(A)).pushed).toBe(0); // nothing changed since
  });

  it('the other device receives it, keeping device-local fields local', async () => {
    const r = await pass(B);
    expect(r.pulled).toBe(5);
    as(B, () => {
      const h = listHumans().find((x) => x.id === HUMAN);
      expect(h).toMatchObject({ name: 'Weber', model: 'sonnet', projects: [] });
      expect(h?.remoteProjects).toMatchObject([{ projectId: 'prj_one', name: 'app' }]);
      const t = allTasks().find((x) => x.id === 't1');
      expect(t).toMatchObject({ title: '机密任务标题', projectId: 'prj_one', project: '' });
      expect(t?.sessionId).toBeUndefined();
      const meta = humanMetaDir(HUMAN);
      expect(readFileSync(join(meta, 'knowledge', 'sync.md'), 'utf8')).toBe('relay has no ssh\n');
      expect(readFileSync(join(B.home, 'prompts', 'handoff.txt'), 'utf8')).toBe(
        'my handoff prompt {{META_DIR}}',
      );
    });
    // receiving is not a change: B pushes nothing back, A pulls nothing new
    expect((await pass(B)).pushed).toBe(0);
    expect((await pass(A)).pulled).toBe(0);
  });

  it('an edit on one device reaches the other; a delete too', async () => {
    as(B, () => updateTask('t1', { title: '改过的标题' }));
    expect((await pass(B)).pushed).toBe(1);
    expect((await pass(A)).pulled).toBe(1);
    as(A, () => {
      const t = allTasks().find((x) => x.id === 't1');
      expect(t).toMatchObject({
        title: '改过的标题',
        project: '/work/app',
        sessionId: 'local-only',
      });
      removeTask('t1');
    });
    expect((await pass(A)).pushed).toBe(1);
    await pass(B);
    expect(as(B, () => allTasks().find((x) => x.id === 't1'))).toBeUndefined();
  });

  it('the same file changed on both devices: newer stays, the other becomes a conflict copy', async () => {
    const path = (d: Dev) => as(d, () => join(humanMetaDir(HUMAN), 'meta.md'));
    writeFileSync(path(A), '# index from mac\n');
    utimesSync(path(A), new Date(), new Date(Date.now() - 60_000)); // older edit
    writeFileSync(path(B), '# index from pc\n');
    await pass(A); // mac's version reaches the server first
    const r = await pass(B); // pc: its own edit is newer → it wins, mac's becomes a copy
    expect(r.conflicts).toBe(1);
    const metaB = as(B, () => humanMetaDir(HUMAN));
    expect(readFileSync(path(B), 'utf8')).toBe('# index from pc\n');
    const copies = readdirSync(metaB).filter((f) => f.startsWith('meta.conflict-'));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(metaB, copies[0] as string), 'utf8')).toBe('# index from mac\n');
    await pass(B); // push the winner + the copy
    await pass(A);
    expect(readFileSync(path(A), 'utf8')).toBe('# index from pc\n');
    expect(
      readdirSync(as(A, () => humanMetaDir(HUMAN))).filter((f) => f.startsWith('meta.conflict-')),
    ).toHaveLength(1);
    // and it settles
    expect((await pass(A)).pushed + (await pass(B)).pushed).toBe(0);
  });

  it('a human deleted on one device is not deleted on the other', async () => {
    as(A, () => writeFileSync(join(A.home, 'humans.json'), JSON.stringify({ humans: [] })));
    await pass(A);
    await pass(B);
    expect(as(B, () => listHumans().map((h) => h.id))).toEqual([HUMAN]);
  });
});
