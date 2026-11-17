import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LanServerHandle, startLanServer } from './lan-server';

const PASSWORD = 'hunter22';

async function login(port: number, password: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/lan/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

function cookieOf(res: Response): string {
  const c = res.headers.get('set-cookie') ?? '';
  return c.split(';')[0] ?? '';
}

describe('lan-server', () => {
  let uiDir: string;
  let handle: LanServerHandle;
  const connections: unknown[] = [];

  beforeAll(async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'lan-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<html>THE-APP</html>');
    mkdirSync(join(uiDir, 'assets'));
    writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1)');
    handle = await startLanServer({
      port: 0,
      uiDir,
      verifyPassword: (p) => p === PASSWORD,
      onConnection: (port) => {
        connections.push(port);
        // echo server: proves the Port plumbing end-to-end
        port.onMessage((m) => port.send({ echo: m }));
      },
    });
  });

  afterAll(async () => {
    await handle.close();
    rmSync(uiDir, { recursive: true, force: true });
  });

  it('serves the login page (not the app) when unauthenticated', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('/lan/login');
    expect(body).not.toContain('THE-APP');
  });

  it('rejects a wrong password without a cookie', async () => {
    const res = await login(handle.port, 'nope');
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('accepts the right password and then serves the app', async () => {
    const res = await login(handle.port, PASSWORD);
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^ateam_lan=[0-9a-f]{48}$/);

    const page = await fetch(`http://127.0.0.1:${handle.port}/`, {
      headers: { cookie },
    });
    expect(await page.text()).toContain('THE-APP');

    const asset = await fetch(`http://127.0.0.1:${handle.port}/assets/app.js`, {
      headers: { cookie },
    });
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(await asset.text()).toBe('console.log(1)');
  });

  it('SPA-falls back to index.html and never escapes uiDir', async () => {
    const cookie = cookieOf(await login(handle.port, PASSWORD));
    for (const path of ['/some/spa/route', '/..%2f..%2fetc%2fpasswd', '/../../etc/passwd']) {
      const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
        headers: { cookie },
      });
      expect(await res.text()).toContain('THE-APP');
    }
  });

  it('refuses the websocket without auth and serves it with', async () => {
    const denied = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    await new Promise<void>((resolve) => {
      denied.on('error', () => resolve());
      denied.on('open', () => {
        throw new Error('unauthenticated ws must not open');
      });
    });

    const cookie = cookieOf(await login(handle.port, PASSWORD));
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`, {
      headers: { cookie },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const echoed = new Promise<unknown>((resolve) => {
      ws.on('message', (d) => resolve(JSON.parse(String(d))));
    });
    ws.send(JSON.stringify({ ping: 1 }));
    expect(await echoed).toEqual({ echo: { ping: 1 } });
    ws.close();
  });

  it('locks an IP out after repeated failures', async () => {
    // fresh server: attempt counters are per-instance and the suite above
    // already spent some failures for this IP
    const fresh = await startLanServer({
      port: 0,
      uiDir,
      verifyPassword: () => false,
      onConnection: () => {},
    });
    try {
      let last = 0;
      for (let i = 0; i < 5; i++) last = (await login(fresh.port, 'x')).status;
      expect(last).toBe(403);
      expect((await login(fresh.port, 'x')).status).toBe(429);
    } finally {
      await fresh.close();
    }
  });
});
