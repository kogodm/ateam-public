import type { IncomingMessage, ServerResponse } from 'node:http';
import { BodyTooLarge, json, readBody, readBodyBuffer, send } from './http-util';
import type { Store } from './store';
import { type SyncChange, SyncError, type SyncStore, isBlobId } from './sync-store';

/**
 * `/sync/api/*` — the data plane. A desktop authenticates as the DEVICE it
 * registered (`Authorization: Bearer <deviceId>.<token>`, the tunnel token it
 * already holds) and acts for that device's account. No cookies, no password:
 * revoking the device is what cuts it off, tunnel and sync alike.
 */

export interface SyncApiDeps {
  store: Store;
  sync: SyncStore;
  online: (deviceId: string) => boolean;
  /** the device was revoked — drop its live tunnel */
  onRevoke: (deviceId: string) => void;
  rateLimited: (ip: string) => boolean;
  noteFailure: (ip: string) => void;
  /** mint an invite code on behalf of the signed-in account */
  createInvite?: (email: string, uses: number, days: number) => { code: string; expiresAt: string };
}

const MAX_JSON = 64 * 1024 * 1024;
const MAX_SMALL = 16 * 1024;
const PULL_DEFAULT = 500;
const PULL_MAX = 2000;

interface Caller {
  deviceId: string;
  email: string;
  accountId: string;
}

function authenticate(req: IncomingMessage, store: Store): Caller | undefined {
  const m = /^Bearer ([0-9a-f]{1,32})\.([A-Za-z0-9_-]{1,128})$/.exec(
    req.headers.authorization ?? '',
  );
  if (!m) return undefined;
  const [, deviceId, token] = m as unknown as [string, string, string];
  if (!store.verifyDeviceToken(deviceId, token)) return undefined;
  const email = store.device(deviceId)?.owner ?? '';
  const accountId = store.accountIdOf(email);
  return accountId ? { deviceId, email, accountId } : undefined;
}

/** device list for one owner — shared with the cookie-authed relay page API */
export function devicesOf(
  store: Store,
  owner: string,
  online: (id: string) => boolean,
  currentId?: string,
): {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  current: boolean;
}[] {
  return store.devicesOf(owner).map(({ id, rec }) => ({
    id,
    name: rec.name,
    online: online(id),
    lastSeenAt: rec.lastSeenAt ?? null,
    createdAt: rec.createdAt,
    current: id === currentId,
  }));
}

export async function handleSyncApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: SyncApiDeps,
): Promise<void> {
  try {
    await route(req, res, url, deps);
  } catch (e) {
    if (res.headersSent) return void res.destroy();
    if (e instanceof SyncError) return json(res, e.status, { err: e.message });
    if (e instanceof BodyTooLarge) return json(res, 413, { err: e.message });
    if (e instanceof SyntaxError) return json(res, 400, { err: 'body is not JSON' });
    json(res, 500, { err: e instanceof Error ? e.message : String(e) });
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: SyncApiDeps,
): Promise<void> {
  const ip = req.socket.remoteAddress ?? '?';
  if (deps.rateLimited(ip)) return json(res, 429, { err: 'locked' });
  const who = authenticate(req, deps.store);
  if (!who) {
    deps.noteFailure(ip);
    return json(res, 401, { err: 'unknown or revoked device' });
  }
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const acct = deps.sync.account(who.accountId);

  if (path === '/sync/api/me' && method === 'GET') {
    return json(res, 200, {
      accountId: who.accountId,
      email: who.email,
      deviceId: who.deviceId,
      rev: acct.rev,
      usedBytes: acct.usedBytes,
    });
  }

  if (path === '/sync/api/invites' && method === 'POST' && deps.createInvite) {
    // a signed-in device (its token proves the account) may invite people
    const { uses, days } = JSON.parse((await readBody(req, MAX_SMALL)) || '{}') as {
      uses?: number;
      days?: number;
    };
    return json(res, 200, deps.createInvite(who.email, Math.min(uses ?? 1, 5), Math.min(days ?? 7, 30)));
  }
  if (path === '/sync/api/devices' && method === 'GET') {
    return json(res, 200, { devices: devicesOf(deps.store, who.email, deps.online, who.deviceId) });
  }
  if (path === '/sync/api/devices/rename' && method === 'POST') {
    const { id, name } = JSON.parse(await readBody(req, MAX_SMALL)) as {
      id?: string;
      name?: string;
    };
    if (!id || !name || !deps.store.renameDevice(id, who.email, name))
      return json(res, 404, { err: 'no such device' });
    return json(res, 200, { ok: true });
  }
  if (path === '/sync/api/devices/revoke' && method === 'POST') {
    const { id } = JSON.parse(await readBody(req, MAX_SMALL)) as { id?: string };
    if (!id || !deps.store.removeDevice(id, who.email))
      return json(res, 404, { err: 'no such device' });
    deps.onRevoke(id);
    return json(res, 200, { ok: true });
  }

  if (path === '/sync/api/key' && method === 'GET') return json(res, 200, acct.getKey());
  if (path === '/sync/api/key' && method === 'PUT') {
    const { envelope, ifVersion } = JSON.parse(await readBody(req, MAX_SMALL)) as {
      envelope?: unknown;
      ifVersion?: number;
    };
    if (!Number.isInteger(ifVersion)) return json(res, 400, { err: 'ifVersion required' });
    try {
      return json(res, 200, acct.putKey(envelope, ifVersion as number));
    } catch (e) {
      // hand back what won, so the caller can unwrap it instead of guessing
      if (e instanceof SyncError && e.status === 409)
        return json(res, 409, { err: e.message, ...acct.getKey() });
      throw e;
    }
  }

  if (path === '/sync/api/push' && method === 'POST') {
    const { changes } = JSON.parse(await readBody(req, MAX_JSON)) as { changes?: SyncChange[] };
    return json(res, 200, acct.push(who.deviceId, changes as SyncChange[]));
  }
  if (path === '/sync/api/pull' && method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? PULL_DEFAULT);
    if (!Number.isInteger(since) || since < 0)
      return json(res, 400, { err: 'since must be a non-negative integer' });
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, PULL_MAX) : PULL_DEFAULT;
    return json(res, 200, acct.pull(since, n));
  }

  if (path === '/sync/api/blobs/missing' && method === 'POST') {
    const { ids } = JSON.parse(await readBody(req, MAX_JSON)) as { ids?: unknown };
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string'))
      return json(res, 400, { err: 'ids must be an array of strings' });
    return json(res, 200, { missing: acct.missingBlobs(ids as string[]) });
  }
  const blob = /^\/sync\/api\/blobs\/([^/]+)$/.exec(path)?.[1];
  if (blob !== undefined) {
    if (!isBlobId(blob)) return json(res, 400, { err: 'blob id must be 64 hex chars' });
    if (method === 'GET') return send(res, 200, 'application/octet-stream', acct.readBlob(blob));
    if (method === 'HEAD') {
      res.writeHead(acct.hasBlob(blob) ? 200 : 404, { 'cache-control': 'no-store' });
      return void res.end();
    }
    if (method === 'PUT') {
      const body = await readBodyBuffer(req, MAX_JSON);
      return json(res, 200, acct.putBlob(blob, body));
    }
  }

  json(res, 404, { err: 'unknown endpoint' });
}
