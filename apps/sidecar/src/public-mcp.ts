/**
 * Public MCP endpoint for web connectors (ChatGPT / Claude / Gemini). Listens on loopback only;
 * a Cloudflare Tunnel (see cloudflared.ts) carries https://<host>/ to it. Every call needs an
 * OAuth access token, and every sign-in needs the user's approval in Ateam with a matching code.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { join } from 'node:path';
import { type ExternalAccess, OAuthError, OAuthStore, basicClientId } from '@ateam/core';
import { startCloudflared } from './cloudflared';

type Serve = (req: IncomingMessage, res: ServerResponse, clientId: string) => Promise<void> | void;

interface AuthRequest {
  query: Record<string, string>;
  grantee: { id: string; name: string };
  pairingCode: string;
}

/** `<home>/external-mcp/public.json` written by scripts/setup-public-mcp.sh */
export function readPublicConfig(home: string): { url: string } | undefined {
  const file = join(home, 'external-mcp', 'public.json');
  if (!existsSync(file)) return undefined;
  const { url } = JSON.parse(readFileSync(file, 'utf8')) as { url?: unknown };
  if (typeof url !== 'string') throw new Error('public.json needs a url.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search)
    throw new Error('Public MCP url must be an https origin.');
  return { url: parsed.origin };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, refresh = false): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${
    refresh ? '<meta http-equiv="refresh" content="2">' : ''
  }<title>${escapeHtml(title)}</title><style>body{font:16px -apple-system,system-ui,sans-serif;max-width:28rem;margin:15vh auto;padding:0 1.5rem;color:#222}h1{font-size:1.3rem}.code{font:600 2rem ui-monospace,monospace;letter-spacing:.3rem;margin:1.5rem 0}p{color:#555;line-height:1.5}</style></head><body><h1>${escapeHtml(
    title,
  )}</h1>${body}</body></html>`;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new OAuthError('invalid_request', 'Request too large.');
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] ?? '').includes('application/json'))
    return JSON.parse(text || '{}') as Record<string, unknown>;
  return Object.fromEntries(new URLSearchParams(text));
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export async function startPublicMcp(opts: {
  access: ExternalAccess;
  port: number;
  serve: Serve;
}): Promise<{ close: () => Promise<void> } | undefined> {
  const { access, port, serve } = opts;
  const config = readPublicConfig(access.home);
  if (!config) return undefined;
  const base = config.url;
  const host = new URL(base).host;
  const oauth = new OAuthStore(join(access.home, 'external-mcp', 'oauth.json'));
  const requests = new Map<string, AuthRequest>();
  const hits = new Map<string, { start: number; count: number }>();

  const json = (res: ServerResponse, status: number, body: unknown, headers = {}) =>
    res
      .writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...headers,
      })
      .end(JSON.stringify(body));
  const html = (res: ServerResponse, status: number, body: string) =>
    res
      .writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'X-Frame-Options': 'DENY',
      })
      .end(body);
  const limited = (req: IncomingMessage): boolean => {
    const ip = str(req.headers['cf-connecting-ip']) ?? req.socket.remoteAddress ?? '';
    const now = Date.now();
    let rate = hits.get(ip);
    if (!rate || now - rate.start >= 60_000) {
      rate = { start: now, count: 0 };
      hits.set(ip, rate);
    }
    return ++rate.count > 60;
  };

  const resourceMeta = {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
  };
  const serverMeta = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };

  const authorize = (res: ServerResponse, url: URL) => {
    const id = url.searchParams.get('req');
    if (!id) {
      const query = Object.fromEntries(url.searchParams);
      const grantee = oauth.checkAuthorize(query);
      let pairingCode: string;
      try {
        pairingCode = access.requestPairing(grantee.id, grantee.name);
      } catch {
        html(
          res,
          429,
          page(
            'Another sign-in is waiting',
            '<p>Answer the request already open in Ateam, then try connecting again.</p>',
          ),
        );
        return;
      }
      const reqId = randomUUID();
      requests.set(reqId, { query, grantee, pairingCode });
      res.writeHead(302, {
        Location: `/oauth/authorize?req=${reqId}`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    const pending = requests.get(id);
    const state = pending && access.pairingState(pending.grantee.id, pending.pairingCode);
    if (!pending || !state || state === 'expired') {
      if (pending) requests.delete(id);
      html(
        res,
        410,
        page('Sign-in expired', '<p>Nothing was approved. Start the connection again.</p>'),
      );
      return;
    }
    if (state === 'pending') {
      html(
        res,
        200,
        page(
          'Approve in Ateam',
          `<p>Open Ateam on your computer and allow ${escapeHtml(
            pending.grantee.name,
          )}. Check that the dialog shows this code:</p><div class="code">${pending.pairingCode}</div><p>This page continues automatically.</p>`,
          true,
        ),
      );
      return;
    }
    requests.delete(id);
    const target = new URL(pending.query.redirect_uri as string);
    if (state === 'approved') {
      target.searchParams.set(
        'code',
        oauth.issueCode({
          oauthClient: pending.query.client_id as string,
          redirectUri: pending.query.redirect_uri as string,
          challenge: pending.query.code_challenge ?? '',
          grantee: pending.grantee.id,
          grantedAt: Date.now(),
        }),
      );
    } else target.searchParams.set('error', 'access_denied');
    if (pending.query.state) target.searchParams.set('state', pending.query.state);
    target.searchParams.set('iss', base);
    res.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store' }).end();
  };

  const http = createServer(async (req, res) => {
    if (![host, `127.0.0.1:${port}`].includes(req.headers.host ?? '')) {
      res.writeHead(421).end();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'www-authenticate, mcp-session-id, mcp-protocol-version',
    );
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    const url = new URL(req.url ?? '/', base);
    const path = url.pathname;
    try {
      if (path === '/mcp') {
        const grant = oauth.verify(req.headers.authorization ?? '');
        if (!grant || !access.grantValid(grant.grantee, grant.grantedAt)) {
          json(
            res,
            401,
            { error: 'invalid_token' },
            {
              'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
            },
          );
          return;
        }
        await serve(req, res, grant.grantee);
        return;
      }
      if (limited(req)) {
        res.writeHead(429, { 'Retry-After': '30' }).end();
        return;
      }
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        path.startsWith('/.well-known/oauth-protected-resource')
      )
        return json(res, 200, resourceMeta);
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        (path.startsWith('/.well-known/oauth-authorization-server') ||
          path.startsWith('/.well-known/openid-configuration'))
      )
        return json(res, 200, serverMeta);
      if (req.method === 'POST' && path === '/oauth/register')
        return json(res, 201, {
          ...oauth.register(await readBody(req)),
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        });
      if (req.method === 'GET' && path === '/oauth/authorize') return authorize(res, url);
      if (req.method === 'POST' && path === '/oauth/token') {
        const b = await readBody(req);
        const grant = str(b.grant_type);
        const clientId = str(b.client_id) ?? basicClientId(req.headers.authorization);
        if (grant === 'authorization_code')
          return json(
            res,
            200,
            oauth.exchangeCode({
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
            oauth.refresh({ refresh_token: str(b.refresh_token), client_id: clientId }),
          );
        throw new OAuthError('unsupported_grant_type');
      }
      res.writeHead(404).end();
    } catch (error) {
      if (res.headersSent) return void res.end();
      if (error instanceof OAuthError) {
        if (path === '/oauth/authorize')
          return html(res, 400, page('Cannot connect', `<p>${escapeHtml(error.message)}</p>`));
        return json(res, 400, { error: error.code, error_description: error.message });
      }
      json(res, 400, { error: 'invalid_request' });
    }
  });
  http.requestTimeout = 15_000;
  http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', resolve);
  });
  const tunnel = startCloudflared(access.home, (state, error) => {
    access.publicMcp = { url: `${base}/mcp`, tunnel: state, ...(error ? { error } : {}) };
    access.emit('changed');
  });
  return {
    close: async () => {
      tunnel.stop();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
