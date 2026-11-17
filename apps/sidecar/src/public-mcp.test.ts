import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTERNAL_TOOLS, ExternalAccess, type SessionManager } from '@ateam/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it, vi } from 'vitest';
import { startExternalMcp } from './external-mcp';

const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
type Json = {
  client_id: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  authorization_servers: string[];
  code_challenge_methods_supported: string[];
};

async function freePort(): Promise<number> {
  for (;;) {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const second = createServer();
    const ok = await new Promise<boolean>((r) => {
      second.once('error', () => r(false));
      second.listen(port + 2, '127.0.0.1', () => r(true));
    });
    if (ok) {
      await new Promise<void>((r) => second.close(() => r()));
      return port;
    }
  }
}

it('web connector signs in with OAuth + matching code in Ateam, calls tools, and loses access on revoke', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-public-mcp-')));
  const old = process.env.ATEAM_HOME;
  process.env.ATEAM_HOME = home;
  const access = new ExternalAccess(home, () => [home]);
  access.port = await freePort();
  writeFileSync(
    join(home, 'external-mcp', 'public.json'),
    JSON.stringify({ url: 'https://mcp.test.example' }),
  );
  const manager = {
    listPeerSessions: () => [
      {
        id: 'real',
        name: 'Test',
        provider: 'codex',
        projectDir: home,
        model: '',
        state: 'idle' as const,
      },
    ],
    deliverExternalMessage: vi.fn(() => false),
    externalReply: undefined,
  };
  const service = await startExternalMcp(manager as unknown as SessionManager, undefined, access);
  const base = `http://127.0.0.1:${access.port + 2}`;
  const get = (path: string) => fetch(`${base}${path}`, { redirect: 'manual' });
  const post = (path: string, body: Record<string, string> | object, json = false) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
      body: json ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>),
    });
  try {
    expect(access.publicMcp?.url).toBe('https://mcp.test.example/mcp');

    const unauthorized = await post('/mcp', {}, true);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.test.example/.well-known/oauth-protected-resource"',
    );
    const resource = (await (
      await get('/.well-known/oauth-protected-resource/mcp')
    ).json()) as Json;
    expect(resource.authorization_servers).toEqual(['https://mcp.test.example']);
    const meta = (await (await get('/.well-known/oauth-authorization-server')).json()) as Record<
      string,
      string
    >;
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);

    expect(
      (await post('/oauth/register', { redirect_uris: ['https://evil.example/cb'] }, true)).status,
    ).toBe(400);
    const { client_id } = (await (
      await post('/oauth/register', { redirect_uris: [REDIRECT], client_name: 'ChatGPT' }, true)
    ).json()) as Json;

    const signIn = async () => {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const q = new URLSearchParams({
        response_type: 'code',
        client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz',
      });
      const start = await get(`/oauth/authorize?${q}`);
      expect(start.status).toBe(302);
      const waiting = start.headers.get('location') as string;
      const pagePending = await get(waiting);
      const html = await pagePending.text();
      const pending = access.status().pending[0];
      expect(pending?.id).toBe('chatgpt-chat');
      expect(html).toContain(pending?.pairingCode);
      return { waiting, verifier };
    };

    // Deny first: redirected back with access_denied, nothing granted.
    const denied = await signIn();
    access.decide('chatgpt-chat', false, []);
    const deniedBack = new URL((await get(denied.waiting)).headers.get('location') as string);
    expect(deniedBack.searchParams.get('error')).toBe('access_denied');
    expect(deniedBack.searchParams.get('state')).toBe('xyz');

    const { waiting, verifier } = await signIn();
    access.decide('chatgpt-chat', true, [home]);
    const back = new URL((await get(waiting)).headers.get('location') as string);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    const code = back.searchParams.get('code') as string;

    const exchange = { grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT };
    const tokens = (await (
      await post('/oauth/token', { ...exchange, code_verifier: verifier })
    ).json()) as Json;
    expect(tokens.token_type).toBe('Bearer');
    expect((await post('/oauth/token', { ...exchange, code_verifier: verifier })).status).toBe(400);

    const connect = async (accessToken: string) => {
      const client = new Client({ name: 'web-spec', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
        }),
      );
      return client;
    };
    const client = await connect(tokens.access_token);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(
      EXTERNAL_TOOLS.map((t) => t.name).sort(),
    );
    const listed = await client.callTool({ name: 'list_sessions', arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect(JSON.stringify(listed.content)).toContain('real');
    await client.close();

    const rotated = (await (
      await post('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id,
      })
    ).json()) as Json;
    expect(rotated.access_token).toBeTruthy();
    expect(
      (
        await post('/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id,
        })
      ).status,
    ).toBe(400);

    access.revoke('chatgpt-chat');
    const afterRevoke = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rotated.access_token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(afterRevoke.status).toBe(401);

    // Gemini web connector redirect URIs are accepted too.
    const geminiReg = await post(
      '/oauth/register',
      {
        redirect_uris: [
          'https://oauth-redirect.googleusercontent.com/r/gemini',
          'https://oauth-redirect-sandbox.googleusercontent.com/r/gemini',
          'https://vertexaisearch.cloud.google.com/oauth-redirect',
        ],
        client_name: 'Gemini',
      },
      true,
    );
    expect(geminiReg.status).toBe(201);

    // A foreign Host never reaches the handlers.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      request(
        `${base}/.well-known/oauth-authorization-server`,
        { headers: { Host: 'evil.example' } },
        (r) => resolve(r.statusCode ?? 0),
      ).end();
    });
    expect(status).toBe(421);
  } finally {
    await service.close();
    process.env.ATEAM_HOME = old;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
