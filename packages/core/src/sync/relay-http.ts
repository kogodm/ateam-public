import { type IncomingMessage, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import { normalizeFingerprint } from '../server/fingerprint';

/** The relay's `/sync/api` as this device sees it (docs/sync/relay-api.md). */
export interface SyncEntry {
  rev: number;
  type: string;
  key: string;
  updatedAt: number;
  deviceId: string;
  deleted?: boolean;
  data?: string;
}
export interface SyncChange {
  type: string;
  key: string;
  baseRev: number;
  updatedAt: number;
  deleted?: boolean;
  data?: string;
}
export interface RelayDevice {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  current: boolean;
}

export interface SyncApi {
  me(): Promise<{ accountId: string; email: string; deviceId: string; rev: number }>;
  getKey(): Promise<{ version: number; envelope: unknown }>;
  /** compare-and-set; `ok:false` hands back what another device stored */
  putKey(
    envelope: unknown,
    ifVersion: number,
  ): Promise<{ ok: true; version: number } | { ok: false; version: number; envelope: unknown }>;
  push(changes: SyncChange[]): Promise<{
    accepted: { type: string; key: string; rev: number }[];
    conflicts: SyncEntry[];
    rev: number;
  }>;
  pull(
    since: number,
    limit?: number,
  ): Promise<{ entries: SyncEntry[]; rev: number; more: boolean }>;
  missingBlobs(ids: string[]): Promise<string[]>;
  putBlob(id: string, body: Buffer): Promise<void>;
  getBlob(id: string): Promise<Buffer>;
  devices(): Promise<RelayDevice[]>;
  /** an invite code for a new relay account, minted for this account */
  createInvite(uses?: number, days?: number): Promise<{ code: string; expiresAt: string }>;
  renameDevice(id: string, name: string): Promise<void>;
  revokeDevice(id: string): Promise<void>;
}

export class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface RelayEndpoint {
  /** https://host:port (http:// only for tests) */
  baseUrl: string;
  deviceId: string;
  token: string;
  /** pin a self-signed relay certificate; '' = system trust */
  tlsFingerprint?: string;
}

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE = 64 * 1024 * 1024;

/**
 * One request. With a pinned fingerprint the TLS connection is opened and its
 * certificate checked BEFORE the request is written: the Authorization header
 * carries the device token, and an impostor must never see it.
 */
function call(
  ep: RelayEndpoint,
  method: string,
  path: string,
  body?: Buffer | string,
  contentType = 'application/json',
): Promise<{ status: number; body: Buffer }> {
  const u = new URL(path, ep.baseUrl);
  const headers: Record<string, string | number> = {
    authorization: `Bearer ${ep.deviceId}.${ep.token}`,
  };
  if (body !== undefined) {
    headers['content-type'] = contentType;
    headers['content-length'] = Buffer.byteLength(body);
  }
  const collect = (
    res: IncomingMessage,
    done: (r: { status: number; body: Buffer }) => void,
    fail: (e: Error) => void,
  ): void => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_RESPONSE) {
        res.destroy(new Error('relay response too large'));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    res.on('error', fail);
  };
  return new Promise((resolve, reject) => {
    if (u.protocol === 'http:') {
      const req = httpRequest(u, { method, headers, timeout: TIMEOUT_MS }, (res) =>
        collect(res, resolve, reject),
      );
      req.on('timeout', () => req.destroy(new Error('relay did not answer in time')));
      req.on('error', reject);
      req.end(body);
      return;
    }
    const pin = normalizeFingerprint(ep.tlsFingerprint ?? '');
    const port = Number(u.port || 443);
    const send = (sock?: TLSSocket): void => {
      const req = httpsRequest(
        {
          host: u.hostname,
          port,
          method,
          path: `${u.pathname}${u.search}`,
          headers,
          timeout: TIMEOUT_MS,
          agent: false,
          ...(sock ? { createConnection: () => sock } : {}),
        },
        (res) => collect(res, resolve, reject),
      );
      req.on('timeout', () => req.destroy(new Error('relay did not answer in time')));
      req.on('error', reject);
      req.end(body);
    };
    if (!pin) {
      send();
      return;
    }
    const sock = tlsConnect({
      host: u.hostname,
      port,
      servername: u.hostname,
      rejectUnauthorized: false,
    });
    sock.setTimeout(TIMEOUT_MS, () => sock.destroy(new Error('relay did not answer in time')));
    sock.once('error', reject);
    sock.once('secureConnect', () => {
      const got = (sock.getPeerCertificate()?.fingerprint256 ?? '').replace(/:/g, '').toUpperCase();
      if (got !== pin) {
        sock.destroy();
        reject(
          new Error(`relay certificate fingerprint mismatch (${u.hostname} presented ${got})`),
        );
        return;
      }
      sock.removeListener('error', reject);
      send(sock);
    });
  });
}

async function json<T>(
  ep: RelayEndpoint,
  method: string,
  path: string,
  payload?: unknown,
): Promise<T> {
  const r = await call(
    ep,
    method,
    path,
    payload === undefined ? undefined : JSON.stringify(payload),
  );
  let o: Record<string, unknown> = {};
  try {
    o = r.body.length ? (JSON.parse(r.body.toString('utf8')) as Record<string, unknown>) : {};
  } catch {
    throw new RelayHttpError(
      r.status,
      `relay answered ${r.status} with something that is not JSON`,
    );
  }
  if (r.status < 200 || r.status >= 300)
    throw new RelayHttpError(r.status, String(o.err ?? `relay answered ${r.status}`), o);
  return o as T;
}

export function relaySyncApi(ep: RelayEndpoint): SyncApi {
  return {
    me: () => json(ep, 'GET', '/sync/api/me'),
    getKey: () => json(ep, 'GET', '/sync/api/key'),
    async putKey(envelope, ifVersion) {
      try {
        const r = await json<{ version: number }>(ep, 'PUT', '/sync/api/key', {
          envelope,
          ifVersion,
        });
        return { ok: true, version: r.version };
      } catch (e) {
        if (e instanceof RelayHttpError && e.status === 409)
          return { ok: false, version: Number(e.body?.version ?? 0), envelope: e.body?.envelope };
        throw e;
      }
    },
    push: (changes) => json(ep, 'POST', '/sync/api/push', { changes }),
    pull: (since, limit = 500) => json(ep, 'GET', `/sync/api/pull?since=${since}&limit=${limit}`),
    missingBlobs: async (ids) =>
      (await json<{ missing: string[] }>(ep, 'POST', '/sync/api/blobs/missing', { ids })).missing,
    async putBlob(id, body) {
      const r = await call(ep, 'PUT', `/sync/api/blobs/${id}`, body, 'application/octet-stream');
      if (r.status !== 200) throw new RelayHttpError(r.status, `blob upload failed (${r.status})`);
    },
    async getBlob(id) {
      const r = await call(ep, 'GET', `/sync/api/blobs/${id}`);
      if (r.status !== 200)
        throw new RelayHttpError(r.status, `blob ${id.slice(0, 8)} unavailable (${r.status})`);
      return r.body;
    },
    createInvite: (uses, days) => json(ep, 'POST', '/sync/api/invites', { uses, days }),
    devices: async () =>
      (await json<{ devices: RelayDevice[] }>(ep, 'GET', '/sync/api/devices')).devices,
    async renameDevice(id, name) {
      await json(ep, 'POST', '/sync/api/devices/rename', { id, name });
    },
    async revokeDevice(id) {
      await json(ep, 'POST', '/sync/api/devices/revoke', { id });
    },
  };
}
