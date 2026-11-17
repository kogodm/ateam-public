/**
 * One MCP endpoint for all of an account's machines (ChatGPT Chat mode, Claude web, Gemini web).
 *
 *   connector ──OAuth (relay account login)──▶ relay /mcp
 *   relay ──'mcp' tunnel channel──▶ each machine's external MCP (its own consent dialog)
 *
 * The relay speaks just enough MCP (initialize, tools/list, tools/call) to fan
 * list_sessions out across machines and route everything else by machine_id. A
 * machine only gets 'mcp' channels if it announced the capability.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
// The token store is shared with the desktop's own public endpoint; it uses node builtins only.
import { EXTERNAL_INSTRUCTIONS, EXTERNAL_TOOLS } from '../../../packages/contract/src/external-tools';
import { OAuthError, OAuthStore, basicClientId } from '../../../packages/core/src/external-oauth';
import { BodyTooLarge, json, readBody, send } from './http-util';
import type { Store } from './store';
import type { AgentConn } from './tunnel';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05', '2025-11-25'];
const DEVICE_TIMEOUT_MS = 15_000;
const PAGE = 20;

export function isMcpGatewayPath(path: string): boolean {
  return (
    path === '/mcp' ||
    path.startsWith('/oauth/') ||
    path.startsWith('/.well-known/oauth-') ||
    path.startsWith('/.well-known/openid-configuration')
  );
}

interface Deps {
  store: Store;
  agents: Map<string, AgentConn>;
  oauthFile: string;
  publicUrl?: string;
  rateLimited: (ip: string) => boolean;
  noteFailure: (ip: string) => void;
  clearFailures: (ip: string) => void;
  log: (m: string) => void;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Listing tools span every machine; everything else names one with machine_id. */
const SPANNING = new Set(['list_sessions', 'list_projects', 'list_pending_authorizations']);
const TOOLS = EXTERNAL_TOOLS.map((t) =>
  SPANNING.has(t.name)
    ? {
        ...t,
        description: `${t.description} Covers all of the user's machines; each item carries machine_id and machine.`,
      }
    : {
        ...t,
        inputSchema: {
          ...t.inputSchema,
          properties: {
            machine_id: {
              type: 'string',
              description: 'machine_id from list_projects or list_sessions',
            },
            ...t.inputSchema.properties,
          },
          required: ['machine_id', ...(t.inputSchema.required ?? [])],
        },
      },
);

const INSTRUCTIONS = `${EXTERNAL_INSTRUCTIONS}

Several machines: every project and session carries machine_id and machine (the computer's name). Always pass the machine_id of the project or session you address. Each machine asks its owner to approve access once, in the Ateam window on that computer.`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(reqId: string, error = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ateam</title><style>html,body{margin:0;height:100%;background:#101014;color:#e8e8ec;font:15px/1.5 -apple-system,'Segoe UI',sans-serif}.wrap{display:flex;align-items:center;justify-content:center;min-height:100%;padding:24px;box-sizing:border-box}form{background:#17171d;border:1px solid #2a2a33;border-radius:12px;padding:28px;width:340px;display:flex;flex-direction:column;gap:12px}h1{font-size:17px;margin:0 0 4px;font-weight:600}input{background:#101014;border:1px solid #33333d;border-radius:8px;color:inherit;padding:10px 12px;font-size:15px}button{background:#5a5af0;border:0;border-radius:8px;color:#fff;padding:10px;font-size:15px;cursor:pointer}.err{color:#ff7676;font-size:13px;margin:0}.muted{color:#9a9aa5;font-size:13px;margin:0}</style></head><body><div class="wrap"><form method="post" action="/oauth/authorize"><h1>Connect to Ateam</h1><p class="muted">Sign in with your Ateam relay account. Each computer will also ask you to approve access in its Ateam window.</p><input type="hidden" name="req" value="${escapeHtml(
    reqId,
  )}"><input name="email" type="email" placeholder="Email" autocomplete="username" required autofocus><input name="password" type="password" placeholder="Password" autocomplete="current-password" required><button type="submit">Sign in</button>${
    error ? `<p class="err">${escapeHtml(error)}</p>` : ''
  }</form></div></body></html>`;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export class McpGateway {
  private readonly oauth: OAuthStore;
  private readonly pending = new Map<
    string,
    { query: Record<string, string>; expiresAt: number }
  >();

  constructor(private readonly d: Deps) {
    this.oauth = new OAuthStore(d.oauthFile);
  }

  private base(req: IncomingMessage): string {
    return (this.d.publicUrl ?? `https://${req.headers.host ?? 'localhost'}`).replace(/\/+$/, '');
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const base = this.base(req);
    const ip = req.socket.remoteAddress ?? '?';
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, DELETE, OPTIONS');
    res.setHeader(
      'access-control-allow-headers',
      'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
    );
    res.setHeader(
      'access-control-expose-headers',
      'www-authenticate, mcp-session-id, mcp-protocol-version',
    );
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'cache-control': 'no-store' }).end();
      return;
    }
    try {
      if (path === '/mcp') return await this.mcp(req, res, base);
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        path.startsWith('/.well-known/oauth-protected-resource')
      )
        return json(res, 200, {
          resource: `${base}/mcp`,
          authorization_servers: [base],
          bearer_methods_supported: ['header'],
        });
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        (path.startsWith('/.well-known/oauth-authorization-server') ||
          path.startsWith('/.well-known/openid-configuration'))
      )
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      if (this.d.rateLimited(ip)) return json(res, 429, { error: 'temporarily_locked' });
      if (req.method === 'POST' && path === '/oauth/register')
        return json(res, 201, {
          ...this.oauth.register(await this.body(req)),
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        });
      if (req.method === 'GET' && path === '/oauth/authorize') {
        const url = new URL(req.url ?? '/', base);
        const query = Object.fromEntries(url.searchParams);
        this.oauth.checkAuthorize(query);
        const id = randomUUID();
        this.prune();
        this.pending.set(id, { query, expiresAt: Date.now() + 10 * 60_000 });
        return this.html(res, 200, loginPage(id));
      }
      if (req.method === 'POST' && path === '/oauth/authorize') {
        const b = await this.body(req);
        const id = str(b.req) ?? '';
        const p = this.pending.get(id);
        if (!p || p.expiresAt <= Date.now())
          return this.html(
            res,
            410,
            loginPage('', 'This sign-in expired. Start again from your connector.'),
          );
        const email = str(b.email) ?? '';
        if (!this.d.store.verifyUser(email, str(b.password) ?? '')) {
          this.d.noteFailure(ip);
          return this.html(res, 401, loginPage(id, 'Wrong email or password.'));
        }
        this.d.clearFailures(ip);
        this.pending.delete(id);
        const target = new URL(p.query.redirect_uri as string);
        target.searchParams.set(
          'code',
          this.oauth.issueCode({
            oauthClient: p.query.client_id as string,
            redirectUri: p.query.redirect_uri as string,
            challenge: p.query.code_challenge ?? '',
            grantee: email.trim().toLowerCase(),
            grantedAt: Date.now(),
          }),
        );
        if (p.query.state) target.searchParams.set('state', p.query.state);
        target.searchParams.set('iss', base);
        this.d.log(`mcp sign-in ${email.trim().toLowerCase()}`);
        res.writeHead(302, { location: target.href, 'cache-control': 'no-store' }).end();
        return;
      }
      if (req.method === 'POST' && path === '/oauth/token') {
        const b = await this.body(req);
        const grant = str(b.grant_type);
        const clientId = str(b.client_id) ?? basicClientId(req.headers.authorization);
        if (grant === 'authorization_code')
          return json(
            res,
            200,
            this.oauth.exchangeCode({
              code: str(b.code),
              code_verifier: str(b.code_verifier),
              client_id: clientId,
              redirect_uri: str(b.redirect_uri),
            }),
          );
        if (grant === 'refresh_token')
          return json(
            res,
            200,
            this.oauth.refresh({
              refresh_token: str(b.refresh_token),
              client_id: clientId,
            }),
          );
        throw new OAuthError('unsupported_grant_type');
      }
      json(res, 404, { error: 'not_found' });
    } catch (error) {
      if (res.headersSent) return void res.end();
      if (error instanceof OAuthError) {
        this.d.log(`mcp oauth error ${path}: ${error.code} (${error.message})`);
        if (path === '/oauth/authorize')
          return this.html(res, 400, `<!doctype html><p>${escapeHtml(error.message)}</p>`);
        return json(res, 400, { error: error.code, error_description: error.message });
      }
      json(res, error instanceof BodyTooLarge ? 413 : 400, { error: 'invalid_request' });
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(id);
  }

  private html(res: ServerResponse, status: number, body: string): void {
    send(res, status, 'text/html; charset=utf-8', body, {
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-frame-options': 'DENY',
    });
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readBody(req, 64 * 1024);
    if ((req.headers['content-type'] ?? '').includes('application/json'))
      return JSON.parse(raw || '{}') as Record<string, unknown>;
    return Object.fromEntries(new URLSearchParams(raw));
  }

  // ------------------------------------------------------------- MCP
  private async mcp(req: IncomingMessage, res: ServerResponse, base: string): Promise<void> {
    const grant = this.oauth.verify(req.headers.authorization ?? '');
    if (!grant || !this.d.store.hasUser(grant.grantee)) {
      json(
        res,
        401,
        { error: 'invalid_token' },
        {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        },
      );
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const msg = JSON.parse((await readBody(req, 64 * 1024)) || 'null') as {
      id?: string | number;
      method?: string;
      params?: Record<string, unknown>;
    } | null;
    if (!msg || Array.isArray(msg) || typeof msg.method !== 'string') {
      json(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid request' },
      });
      return;
    }
    if (msg.id === undefined) {
      res.writeHead(202).end(); // notification
      return;
    }
    const reply = (result: unknown) => json(res, 200, { jsonrpc: '2.0', id: msg.id, result });
    const fail = (code: number, message: string) =>
      json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize': {
        const asked = str(msg.params?.protocolVersion);
        return reply({
          protocolVersion:
            asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'ateam', version: '0.2.0' },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'resources/list':
        return reply({ resources: [] });
      case 'resources/templates/list':
        return reply({ resourceTemplates: [] });
      case 'prompts/list':
        return reply({ prompts: [] });
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = str(msg.params?.name) ?? '';
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
        return reply(await this.call(grant.grantee, name, args));
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  private machines(email: string) {
    return this.d.store.devicesOf(email).map(({ id, rec }) => {
      const agent = this.d.agents.get(id);
      return {
        machine_id: id,
        machine: rec.name,
        agent: agent?.caps.has('mcp') ? agent : undefined,
        status: !agent ? 'offline' : agent.caps.has('mcp') ? 'online' : 'update_ateam',
      };
    });
  }

  private async call(
    email: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ok = (v: unknown): ToolResult => ({
      content: [{ type: 'text', text: JSON.stringify(v) }],
    });
    const err = (m: string): ToolResult => ({
      content: [{ type: 'text', text: m }],
      isError: true,
    });
    if (name === 'list_pending_authorizations') {
      const machines = await Promise.all(
        this.machines(email).map(async (m) => {
          const base = { machine_id: m.machine_id, machine: m.machine };
          if (!m.agent) return { ...base, status: m.status };
          const r = await this.device(m.agent, name, {});
          if (!r.result || r.result.isError)
            return { ...base, status: r.result ? 'error' : r.status, detail: r.result?.content[0]?.text ?? r.error };
          return { ...base, status: 'online', ...(JSON.parse(r.result.content[0]?.text ?? '{}') as object) };
        }),
      );
      return ok({ machines: machines.sort((a, b) => a.machine.localeCompare(b.machine)) });
    }
    if (name === 'list_projects') {
      const machines = this.machines(email);
      const summary: { machine_id: string; machine: string; status: string; detail?: string }[] =
        [];
      const projects: Record<string, unknown>[] = [];
      await Promise.all(
        machines.map(async (m) => {
          if (!m.agent) {
            summary.push({ machine_id: m.machine_id, machine: m.machine, status: m.status });
            return;
          }
          const r = await this.device(m.agent, 'list_projects', {});
          if (!r.result || r.result.isError) {
            summary.push({
              machine_id: m.machine_id,
              machine: m.machine,
              status: r.result ? 'error' : r.status,
              detail: r.result?.content[0]?.text ?? r.error,
            });
            return;
          }
          summary.push({ machine_id: m.machine_id, machine: m.machine, status: 'online' });
          const body = JSON.parse(r.result.content[0]?.text ?? '{}') as {
            projects?: Record<string, unknown>[];
          };
          for (const p of body.projects ?? [])
            projects.push({ machine_id: m.machine_id, machine: m.machine, ...p });
        }),
      );
      summary.sort((a, b) => a.machine.localeCompare(b.machine));
      return ok({ machines: summary, projects });
    }
    if (name === 'list_sessions') {
      const start = typeof args.cursor === 'number' && args.cursor >= 0 ? args.cursor : 0;
      const machines = this.machines(email);
      const summary: { machine_id: string; machine: string; status: string; detail?: string }[] =
        [];
      const sessions: Record<string, unknown>[] = [];
      await Promise.all(
        machines.map(async (m) => {
          if (!m.agent) {
            summary.push({ machine_id: m.machine_id, machine: m.machine, status: m.status });
            return;
          }
          const got = await this.deviceSessions(m.agent);
          summary.push({ machine_id: m.machine_id, machine: m.machine, ...got.status });
          for (const s of got.sessions)
            sessions.push({ machine_id: m.machine_id, machine: m.machine, ...s });
        }),
      );
      summary.sort((a, b) => a.machine.localeCompare(b.machine));
      sessions.sort((a, b) => String(a.machine).localeCompare(String(b.machine)));
      return ok({
        machines: summary,
        sessions: sessions.slice(start, start + PAGE),
        next_cursor: start + PAGE < sessions.length ? start + PAGE : null,
      });
    }
    const id = str(args.machine_id);
    const target = id ? this.machines(email).find((m) => m.machine_id === id) : undefined;
    if (!target)
      return err('Unknown machine_id. Call list_projects or list_sessions to see machines.');
    if (!target.agent)
      return err(
        target.status === 'offline'
          ? `${target.machine} is offline. Open Ateam there with remote access on.`
          : `${target.machine} runs an Ateam version without web connector support. Update it.`,
      );
    const { machine_id: _drop, ...rest } = args;
    const r = await this.device(target.agent, name, rest);
    return r.result ?? err(r.error);
  }

  private async deviceSessions(agent: AgentConn): Promise<{
    status: { status: string; detail?: string };
    sessions: Record<string, unknown>[];
  }> {
    const sessions: Record<string, unknown>[] = [];
    let cursor: number | null = 0;
    for (let page = 0; cursor !== null && page < 10; page++) {
      const r = await this.device(agent, 'list_sessions', { cursor });
      if (!r.result) return { status: { status: r.status, detail: r.error }, sessions };
      if (r.result.isError)
        return { status: { status: 'error', detail: r.result.content[0]?.text }, sessions };
      const body = JSON.parse(r.result.content[0]?.text ?? '{}') as {
        sessions?: Record<string, unknown>[];
        next_cursor?: number | null;
      };
      sessions.push(...(body.sessions ?? []));
      cursor = body.next_cursor ?? null;
    }
    return { status: { status: 'online' }, sessions };
  }

  /** One tools/call on a machine's external MCP, over a fresh tunnel channel. */
  private device(
    agent: AgentConn,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result?: ToolResult; status: string; error: string }> {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return new Promise((resolve) => {
      const done = (v: { result?: ToolResult; status: string; error: string }) => resolve(v);
      const req = httpRequest(
        {
          createConnection: () =>
            agent.openStream(undefined, 'mcp') as unknown as import('node:net').Socket,
          method: 'POST',
          path: '/mcp',
          headers: {
            host: '127.0.0.1',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': Buffer.byteLength(payload),
            connection: 'close',
          },
          timeout: DEVICE_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 403) {
              const code = (() => {
                try {
                  return (JSON.parse(text) as { error?: string }).error ?? '';
                } catch {
                  return '';
                }
              })();
              return done({
                status: 'needs_approval',
                error:
                  code === 'approval_pending'
                    ? 'Waiting for approval in the Ateam window on this computer.'
                    : 'Access was denied or revoked on this computer. Allow a new request in its Ateam Settings → MCP.',
              });
            }
            try {
              const body = JSON.parse(text) as {
                result?: ToolResult;
                error?: { message?: string };
              };
              if (body.result) return done({ result: body.result, status: 'online', error: '' });
              done({ status: 'error', error: body.error?.message ?? `HTTP ${res.statusCode}` });
            } catch {
              done({ status: 'error', error: `Unexpected reply (HTTP ${res.statusCode}).` });
            }
          });
          res.on('error', () => done({ status: 'error', error: 'Machine connection dropped.' }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) =>
        done({
          status: 'error',
          error:
            e.message === 'timeout'
              ? 'Machine did not answer in time.'
              : 'Machine connection failed.',
        }),
      );
      req.end(payload);
    });
  }
}
