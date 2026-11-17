import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { ExternalAccess, type SessionManager } from '../../../packages/core/src/index';
import { RelayClient } from '../../../packages/core/src/server/relay-client';
import { startExternalMcp } from '../../sidecar/src/external-mcp';
import { McpGateway } from './mcp-gateway';
import { Store } from './store';
import { AgentConn } from './tunnel';

const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
type Json = Record<string, string>;

const listen = async (server: {
  listen: (port: number, host: string, cb: () => void) => unknown;
  address: () => unknown;
}) => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
};

it('one relay connector reaches each machine by machine_id, behind account OAuth and per-machine approval', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-relay-mcp-')));
  const old = process.env.ATEAM_HOME;
  process.env.ATEAM_HOME = home;
  const cleanups: (() => unknown)[] = [];
  try {
    // ---- relay side
    const store = new Store(join(home, 'store.json'));
    store.addUser('me@example.com', 'correct horse');
    const dev = store.addDevice('me@example.com', 'Studio Mac');
    store.addDevice('me@example.com', 'Office PC'); // never connects
    const agents = new Map<string, AgentConn>();
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/agent' });
    await new Promise<void>((r) => wss.once('listening', r));
    cleanups.push(() => wss.close());
    wss.on('connection', (ws) => {
      let agent: AgentConn | undefined;
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (!agent) {
          expect(store.verifyDeviceToken(m.device, m.token)).toBe(true);
          agent = new AgentConn(m.device, ws, m.lanToken, new Set(m.caps));
          agents.set(m.device, agent);
          ws.send(JSON.stringify({ t: 'ok', clientPort: 1 }));
          return;
        }
        if (m.ch) agent.onFrame(m);
      });
    });
    const gateway = new McpGateway({
      store,
      agents,
      oauthFile: join(home, 'relay-oauth.json'),
      publicUrl: 'https://relay.test',
      rateLimited: () => false,
      noteFailure: () => {},
      clearFailures: () => {},
      log: () => {},
    });
    const http = createServer((req, res) => {
      void gateway.handle(req, res, (req.url ?? '/').split('?')[0] ?? '/');
    });
    const httpPort = await listen(http);
    cleanups.push(() => http.close());
    const base = `http://127.0.0.1:${httpPort}`;

    // ---- machine side: real sidecar MCP + real RelayClient
    const access = new ExternalAccess(home, () => [home]);
    const probe = createServer();
    access.port = await listen(probe);
    await new Promise<void>((r) => probe.close(() => r()));
    const manager = {
      listPeerSessions: () => [
        {
          id: 'real',
          name: 'Test',
          provider: 'codex',
          projectDir: home,
          model: '',
          state: 'idle' as const,
          human_id: 'h-relay',
          human_name: 'Coder',
        },
      ],
      deliverExternalMessage: vi.fn(() => false),
      externalReply: undefined,
    };
    const service = await startExternalMcp(manager as unknown as SessionManager, undefined, access);
    cleanups.push(() => service.close());
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        lan: { enabled: true, port: 1 },
        remote: {
          enabled: true,
          url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
          deviceId: dev.id,
          token: dev.token,
        },
      }),
    );
    const tunnel = new RelayClient((stream) => service.acceptRelay(stream));
    tunnel.apply();
    cleanups.push(() => tunnel.shutdown());
    await vi.waitFor(() => expect(agents.get(dev.id)?.caps.has('mcp')).toBe(true));

    // ---- OAuth with the relay account
    const post = (path: string, body: object, json = false) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded',
        },
        body: json ? JSON.stringify(body) : new URLSearchParams(body as Json),
      });
    const { client_id } = (await (
      await post('/oauth/register', { redirect_uris: [REDIRECT] }, true)
    ).json()) as Json;
    const verifier = randomBytes(32).toString('base64url');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: client_id as string,
      redirect_uri: REDIRECT,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 's1',
    });
    const page = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
    const reqId = /name="req" value="([^"]+)"/.exec(page)?.[1] as string;
    expect(reqId).toBeTruthy();
    expect(
      (await post('/oauth/authorize', { req: reqId, email: 'me@example.com', password: 'nope' }))
        .status,
    ).toBe(401);
    const signedIn = await post('/oauth/authorize', {
      req: reqId,
      email: 'me@example.com',
      password: 'correct horse',
    });
    const back = new URL(signedIn.headers.get('location') as string);
    expect(back.searchParams.get('state')).toBe('s1');
    const tokens = (await (
      await post('/oauth/token', {
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') as string,
        code_verifier: verifier,
        client_id: client_id as string,
        redirect_uri: REDIRECT,
      })
    ).json()) as Json;

    // ---- MCP through the relay, with the official client
    expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
    const client = new Client({ name: 'chat-spec', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    cleanups.push(() => client.close());
    const instructions = client.getInstructions();
    const listedTools = (await client.listTools()).tools;
    expect(listedTools.map((t) => t.name)).toContain('send_message');
    expect(instructions).toContain('Conversation continuity');
    expect(instructions).toContain('machine_id');
    expect(instructions).toContain('Adapt task difficulty');
    expect(instructions).toContain('MCP direct-first');
    expect(instructions).toContain('Delegate only complex code implementation');
    expect(instructions).toContain('global MCP rules across all Humans');
    expect(instructions).toContain('same-model subagents');
    expect(instructions).toContain('If no reliable association is available, do not guess or block an otherwise authorized MCP task');
    expect(instructions).toContain('read_session_memory');
    expect(instructions.length).toBeLessThan(8000);
    expect(listedTools.find((t) => t.name === 'list_projects')?.description).toContain(
      'rediscover approved projects',
    );
    expect(listedTools.find((t) => t.name === 'list_sessions')?.description).toContain(
      'rediscover real sessions',
    );
    expect(listedTools.find((t) => t.name === 'send_message')?.description).toContain(
      'coordinator owns product scope and acceptance',
    );
    const listing = async () =>
      JSON.parse(
        (
          (await client.callTool({ name: 'list_sessions', arguments: {} })).content as {
            text: string;
          }[]
        )[0]?.text as string,
      ) as {
        machines: { machine_id: string; machine: string; status: string }[];
        sessions: { machine_id: string; machine: string; id: string; project_id: string }[];
      };

    // First contact: the machine asks its owner; nothing is listed yet.
    const before = await listing();
    expect(before.machines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ machine: 'Office PC', status: 'offline' }),
        expect.objectContaining({ machine: 'Studio Mac', status: 'needs_approval' }),
      ]),
    );
    expect(before.sessions).toHaveLength(0);
    expect(access.status().pending.map((p) => p.id)).toEqual(['relay']);
    access.decide('relay', true, [home]);

    const after = await listing();
    // Read code directly, no CLI involved: list_projects spans machines, read_file names one.
    const projectsCall = await client.callTool({ name: 'list_projects', arguments: {} });
    const projects = JSON.parse((projectsCall.content as { text: string }[])[0]?.text as string) as {
      projects: { machine_id: string; machine: string; project_id: string; root: string }[];
    };
    expect(projects.projects[0]).toMatchObject({ machine_id: dev.id, machine: 'Studio Mac', root: home });
    writeFileSync(join(home, 'hello.txt'), 'hello from the machine\n');
    const file = await client.callTool({
      name: 'read_file',
      arguments: { machine_id: dev.id, project_id: projects.projects[0]?.project_id, path: 'hello.txt' },
    });
    expect(JSON.stringify(file.content)).toContain('hello from the machine');
    // Actions need a per-project grant the user approves once on that machine.
    const projectId = projects.projects[0]?.project_id;
    const denied = await client.callTool({
      name: 'run_command',
      arguments: { machine_id: dev.id, project_id: projectId, command: 'echo hi' },
    });
    expect(JSON.stringify(denied.content)).toContain('capability_not_granted');
    const asked = await client.callTool({
      name: 'request_project_access',
      arguments: { machine_id: dev.id, path: home, capabilities: ['execute'], reason: 'run tests' },
    });
    expect(asked.isError).toBeFalsy();
    const pendingReq = access.status().requests?.[0];
    expect(pendingReq).toMatchObject({ root: home, capabilities: ['execute'], reason: 'run tests' });
    access.decideRequest(pendingReq?.id as string, true);
    const ran = await client.callTool({
      name: 'run_command',
      arguments: { machine_id: dev.id, project_id: projectId, command: 'echo hi from relay' },
    });
    expect(JSON.stringify(ran.content)).toContain('hi from relay');
    const auth = await client.callTool({ name: 'list_pending_authorizations', arguments: {} });
    const authBody = JSON.parse((auth.content as { text: string }[])[0]?.text as string) as {
      machines: { machine: string; requests?: { status: string }[] }[];
    };
    expect(authBody.machines.find((m) => m.machine === 'Studio Mac')?.requests?.[0]?.status).toBe('approved');
    // Memory goes to the Human whose session did the work, and comes back next chat.
    const recorded = await client.callTool({
      name: 'record_memory',
      arguments: {
        machine_id: dev.id,
        project_id: projectId,
        session_id: 'real',
        kind: 'experience',
        name: 'relay lesson',
        summary: 'learned through the relay',
        content: 'What happened, what was done, the lesson.',
      },
    });
    expect(recorded.isError).toBeFalsy();
    const memory = await client.callTool({
      name: 'read_session_memory',
      arguments: { machine_id: dev.id, project_id: projectId, session_id: 'real' },
    });
    expect(JSON.parse((memory.content as { text: string }[])[0]?.text as string).index).toContain(
      '- **relay-lesson** — learned through the relay',
    );
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === 'read_file')?.inputSchema.required).toContain('machine_id');
    expect(tools.find((t) => t.name === 'list_projects')?.inputSchema.required ?? []).not.toContain('machine_id');
    const session = after.sessions[0];
    expect(session).toMatchObject({ machine_id: dev.id, machine: 'Studio Mac', id: 'real' });
    const sent = await client.callTool({
      name: 'send_message',
      arguments: {
        machine_id: dev.id,
        project_id: session?.project_id,
        session_id: 'real',
        message: 'hello from chat',
        idempotency_key: 'k1',
      },
    });
    expect(sent.isError).toBeFalsy();
    const { conversation_id } = JSON.parse((sent.content as { text: string }[])[0]?.text as string);
    const read = await client.callTool({
      name: 'get_messages',
      arguments: { machine_id: dev.id, project_id: session?.project_id, conversation_id },
    });
    expect(JSON.stringify(read.content)).toContain('hello from chat');
    const wrong = await client.callTool({
      name: 'get_messages',
      arguments: { machine_id: 'nope', project_id: session?.project_id, conversation_id },
    });
    expect(wrong.isError).toBe(true);

    access.revoke('relay');
    expect((await listing()).machines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ machine: 'Studio Mac', status: 'needs_approval' }),
      ]),
    );
  } finally {
    for (const c of cleanups.reverse()) await c();
    process.env.ATEAM_HOME = old;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

it('accepts Gemini Web OAuth registration, CORS preflight, and Basic auth token exchange', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-relay-gemini-')));
  const cleanups: (() => unknown)[] = [];
  try {
    const store = new Store(join(home, 'store.json'));
    store.addUser('gemini@example.com', 'correct horse');
    const gateway = new McpGateway({
      store,
      agents: new Map(),
      oauthFile: join(home, 'relay-oauth.json'),
      publicUrl: 'https://relay.kriobo.com',
      rateLimited: () => false,
      noteFailure: () => {},
      clearFailures: () => {},
      log: () => {},
    });
    const http = createServer((req, res) => {
      void gateway.handle(req, res, (req.url ?? '/').split('?')[0] ?? '/');
    });
    const httpPort = await listen(http);
    cleanups.push(() => http.close());
    const base = `http://127.0.0.1:${httpPort}`;

    // CORS preflight on /mcp and /.well-known
    const preflight = await fetch(`${base}/mcp`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');

    // Gemini DCR with multiple googleusercontent redirect URIs
    const geminiRedirects = [
      'https://oauth-redirect.googleusercontent.com/r/ateam',
      'https://oauth-redirect-sandbox.googleusercontent.com/r/ateam',
      'https://oauth-redirect-test.googleusercontent.com/r/ateam',
      'https://oauth-redirect.googleusercontent.com/a/ateam',
      'https://oauth-redirect-sandbox.googleusercontent.com/a/ateam',
      'https://oauth-redirect-test.googleusercontent.com/a/ateam',
    ];
    const regRes = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Gemini Web',
        redirect_uris: geminiRedirects,
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    });
    expect(regRes.status).toBe(201);
    const regBody = (await regRes.json()) as Json;
    expect(regBody.client_id).toBeTruthy();
    expect(regBody.client_secret).toBeTruthy();

    // Also support manual Client ID configured in Gemini UI (without prior DCR) + Basic auth at /oauth/token
    const manualClientId = 'gemini-manual-client';
    const manualRedirect = 'https://oauth-redirect.googleusercontent.com/r/manual-project';
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: manualClientId,
      redirect_uri: manualRedirect,
      state: 'gemini-state-123',
    });
    const authPage = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
    const reqId = /name="req" value="([^"]+)"/.exec(authPage)?.[1] as string;
    expect(reqId).toBeTruthy();

    const signedIn = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        req: reqId,
        email: 'gemini@example.com',
        password: 'correct horse',
      }),
    });
    expect(signedIn.status).toBe(302);
    const back = new URL(signedIn.headers.get('location') as string);
    expect(back.origin + back.pathname).toBe(manualRedirect);
    expect(back.searchParams.get('state')).toBe('gemini-state-123');

    const basicHeader = `Basic ${Buffer.from(`${manualClientId}:any-secret`).toString('base64')}`;
    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicHeader,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') as string,
        redirect_uri: manualRedirect,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as Json;
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
  } finally {
    for (const c of cleanups.reverse()) await c();
    rmSync(home, { recursive: true, force: true });
  }
});
