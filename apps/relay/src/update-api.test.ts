import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleUpdateApi } from './update-api';

const TOKEN = 'publish-secret';
let dir: string;
let server: Server;
let base: string;
let failures: string[];

async function start(tokenSha256: string | undefined): Promise<void> {
  failures = [];
  server = createServer((req, res) => {
    void handleUpdateApi(req, res, {
      dir,
      tokenSha256,
      rateLimited: () => false,
      noteFailure: (ip) => failures.push(ip),
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const put = (path: string, body: string, token = TOKEN): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'PUT', body, headers: { authorization: `Bearer ${token}` } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-update-'));
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

describe('update api', () => {
  beforeEach(() => start(sha(TOKEN)));

  it('stores a published file and serves it back', async () => {
    expect((await put('/update/v0.7.0/darwin-aarch64.app.tar.gz', 'bytes')).status).toBe(201);
    const r = await fetch(`${base}/update/v0.7.0/darwin-aarch64.app.tar.gz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('bytes');
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('serves the manifest as JSON that is never cached', async () => {
    await put('/update/latest.json', '{"version":"0.7.0"}');
    const r = await fetch(`${base}/update/latest.json`);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ version: '0.7.0' });
  });

  it('refuses a publish without the right token, and counts it', async () => {
    expect((await put('/update/latest.json', '{}', 'wrong')).status).toBe(401);
    expect(failures).toHaveLength(1);
    expect(existsSync(join(dir, 'latest.json'))).toBe(false);
  });

  it('never writes or reads outside its directory', async () => {
    for (const p of ['/update/../x', '/update/%2e%2e/x', '/update/a/../../x', '/update/.hidden']) {
      expect((await put(p, 'x')).status).toBe(400);
      expect((await fetch(`${base}${p}`)).status).toBe(400);
    }
  });

  it('answers 404 for a file that is not there', async () => {
    expect((await fetch(`${base}/update/nope.json`)).status).toBe(404);
  });

  it('replaces a file whole, leaving no partial files behind', async () => {
    await put('/update/latest.json', '{"version":"0.7.0"}');
    await put('/update/latest.json', '{"version":"0.7.1"}');
    expect(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'))).toEqual({ version: '0.7.1' });
    expect(readdirSync(dir)).toEqual(['latest.json']);
  });
});

describe('update api without a publish token', () => {
  beforeEach(() => start(undefined));

  it('still serves, but accepts no publish', async () => {
    expect((await put('/update/latest.json', '{}')).status).toBe(403);
    expect((await fetch(`${base}/update/latest.json`)).status).toBe(404);
  });
});
