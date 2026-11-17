/**
 * Ateam relay v2 — multi-tenant: accounts own devices; a phone signs in at
 * the relay, picks one of its machines, and everything after that is proxied
 * through the machine's outbound tunnel into its LAN server (whose own
 * password page is a second lock). Desktops self-register with account
 * credentials (Settings → Remote → Remote access), so no relay-side CLI per device.
 *
 *   phone ──TLS──▶ relay :clientPort ──(tunnel)──▶ desktop 127.0.0.1:<lan>
 *   desktop ──wss──▶ relay :agentPort /agent   (device id + token)
 *
 * The agent wire protocol is v1's, unchanged. Relay state: store.json
 * (accounts + devices, atomic writes); sessions in memory.
 */
import { X509Certificate, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import {
  FlapGuard,
  PROXY_MAX_ATTEMPTS,
  hasRetryMark,
  markRetry,
  proxyRetry,
  ssoDecision,
  stripRetry,
} from './gate';
import { json, readBody as readBodyMax, send } from './http-util';
import { InviteStore } from './invites';
import { McpGateway, isMcpGatewayPath } from './mcp-gateway';
import {
  BUSY_HTML,
  LOGIN_HTML,
  NO_PREVIEW_HTML,
  NO_SSO_HTML,
  OFFLINE_HTML,
  PICKER_HTML,
} from './pages';
import { Store } from './store';
import { devicesOf, handleSyncApi } from './sync-api';
import { SyncStore } from './sync-store';
import { AgentConn } from './tunnel';
import { handleUpdateApi } from './update-api';

interface Config {
  clientPort: number;
  agentPort: number;
  /** Public port that serves a DEVICE'S LOCAL WEB SERVER instead of its Ateam
   *  UI — reviewing what you are building, from a phone, off the LAN. Absent
   *  = the feature is off; nothing listens and no channel may name a port. */
  previewPort?: number;
  tls: { cert: string; key: string };
  /** invite (default): a new account needs an invite code; open: anyone may
   *  create one; closed: accounts are created with the CLI only */
  signup?: 'open' | 'closed' | 'invite';
  /** sha256 hex of the token CI publishes desktop updates with (see
   *  update-api.ts). Absent = the feed is read-only. */
  updateTokenSha256?: string;
  /** https origin web connectors use (issuer/resource); default: the request's Host */
  publicUrl?: string;
  /** v1 leftovers — imported into the store by `claim-device` */
  devices?: Record<string, { tokenSha256: string; name?: string }>;
}

const CONFIG_PATH = resolve(process.env.RELAY_CONFIG ?? 'relay.config.json');
const STORE_PATH = resolve(process.env.RELAY_STORE ?? CONFIG_PATH.replace(/[^/]+$/, 'store.json'));
const INVITES_PATH = resolve(STORE_PATH, '..', 'invites.json');
/** per-account ciphertext for cross-device sync (see sync-store.ts) */
const SYNC_DIR = resolve(process.env.RELAY_SYNC_DIR ?? CONFIG_PATH.replace(/[^/]+$/, 'sync'));
/** the desktop app's update feed (see update-api.ts) */
const UPDATE_DIR = resolve(
  process.env.RELAY_UPDATE_DIR ?? CONFIG_PATH.replace(/[^/]+$/, 'updates'),
);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_MS = 30_000;
const MAX_BODY = 4096;
const PING_MS = 25_000;
const MAX_CHANNELS_PER_AGENT = 256;

function loadConfig(): Config {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>;
  if (!raw.clientPort || !raw.agentPort || !raw.tls?.cert || !raw.tls?.key)
    throw new Error(`relay config ${CONFIG_PATH} needs clientPort, agentPort, tls.cert, tls.key`);
  return raw as Config;
}

const log = (m: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${m}\n`);
};

// ---------------------------------------------------------------- CLI
const [cmd, ...cliArgs] = process.argv.slice(2);
if (cmd === 'add-user') {
  const [email, password] = cliArgs;
  if (!email || !password) throw new Error('usage: add-user <email> <password>');
  new Store(STORE_PATH).addUser(email, password);
  process.stdout.write(`user ${email} created\n`);
  process.exit(0);
}
if (cmd === 'claim-device') {
  const [id, owner] = cliArgs;
  if (!id || !owner) throw new Error('usage: claim-device <deviceId> <ownerEmail>');
  const cfg = loadConfig();
  const legacy = cfg.devices?.[id];
  if (!legacy) throw new Error(`device ${id} not found in ${CONFIG_PATH} devices`);
  new Store(STORE_PATH).claimDevice(id, legacy, owner);
  process.stdout.write(`device ${id} now belongs to ${owner}\n`);
  process.exit(0);
}
if (cmd === 'add-invite') {
  const [uses, days] = cliArgs;
  const invite = new InviteStore(INVITES_PATH).create('cli', Number(uses ?? 1), Number(days ?? 7));
  process.stdout.write(`invite ${invite.code} (expires ${invite.expiresAt})\n`);
  process.exit(0);
}
if (cmd === 'list') {
  const st = new Store(STORE_PATH);
  process.stdout.write(`users: ${st.userCount()}\n`);
  process.exit(0);
}
if (cmd === 'fingerprint') {
  const cfg = loadConfig();
  const x = new X509Certificate(readFileSync(cfg.tls.cert));
  process.stdout.write(`${x.fingerprint256}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- state
const cfg = loadConfig();
const store = new Store(STORE_PATH);
const syncStore = new SyncStore(SYNC_DIR);
const invites = new InviteStore(INVITES_PATH);
const signupMode = (): 'open' | 'closed' | 'invite' => cfg.signup ?? 'invite';
const readBody = (req: IncomingMessage): Promise<string> => readBodyMax(req, MAX_BODY);
const tlsOpts = { cert: readFileSync(cfg.tls.cert), key: readFileSync(cfg.tls.key) };
const agents = new Map<string, AgentConn>(); // deviceId → live tunnel
const sessions = new Map<string, { email: string; exp: number }>(); // cookie → session
const attempts = new Map<string, { fails: number; lockedUntil: number }>(); // ip → lockout
const flap = new FlapGuard(); // one device id, two processes → park the loop
const mcpGateway = new McpGateway({
  store,
  agents,
  oauthFile: resolve(STORE_PATH, '..', 'oauth.json'),
  publicUrl: cfg.publicUrl,
  rateLimited: (ip) => rateLimited(ip),
  noteFailure: (ip) => noteFailure(ip),
  clearFailures: (ip) => attempts.delete(ip),
  log,
});

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionOf(req: IncomingMessage): { email: string } | undefined {
  const tok = cookies(req).ateam_rs;
  if (!tok) return undefined;
  const s = sessions.get(tok);
  if (!s) return undefined;
  if (Date.now() > s.exp) {
    sessions.delete(tok);
    return undefined;
  }
  return { email: s.email };
}

function rateLimited(ip: string): boolean {
  const a = attempts.get(ip);
  return !!a && Date.now() < a.lockedUntil;
}
function noteFailure(ip: string): void {
  const a = attempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
  a.fails++;
  if (a.fails >= MAX_LOGIN_FAILURES) {
    a.fails = 0;
    a.lockedUntil = Date.now() + LOCKOUT_MS;
  }
  attempts.set(ip, a);
}

/** a revoked device's token no longer verifies; drop the tunnel it has open */
function revokeTunnel(deviceId: string): void {
  agents.get(deviceId)?.ws.close(4003, 'device revoked');
  log(`device revoked ${deviceId}`);
}

// ---------------------------------------------------------------- relay API
async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const ip = req.socket.remoteAddress ?? '?';
  if (path === '/relay/api/login' && req.method === 'POST') {
    if (rateLimited(ip)) return json(res, 429, { err: 'locked' });
    const { email, password } = JSON.parse(await readBody(req)) as {
      email?: string;
      password?: string;
    };
    if (!email || !password || !store.verifyUser(email, password)) {
      noteFailure(ip);
      return json(res, 401, { err: 'bad credentials' });
    }
    attempts.delete(ip);
    const tok = randomBytes(24).toString('base64url');
    sessions.set(tok, { email: email.trim().toLowerCase(), exp: Date.now() + SESSION_TTL_MS });
    return json(
      res,
      200,
      { ok: true },
      {
        'set-cookie': `ateam_rs=${tok}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
      },
    );
  }
  if (path === '/relay/api/signup' && req.method === 'POST') {
    if (signupMode() === 'closed') return json(res, 403, { err: 'signup disabled' });
    if (rateLimited(ip)) return json(res, 429, { err: 'locked' });
    const { email, password, invite } = JSON.parse(await readBody(req)) as {
      email?: string;
      password?: string;
      invite?: string;
    };
    if (!email?.includes('@') || !password || password.length < 8)
      return json(res, 400, { err: 'valid email + password (min 8 chars) required' });
    if (signupMode() === 'invite' && !invites.valid(invite)) {
      noteFailure(ip);
      return json(res, 403, { err: 'an invite code is required to create an account' });
    }
    try {
      store.addUser(email, password);
    } catch (e) {
      noteFailure(ip);
      return json(res, 409, { err: e instanceof Error ? e.message : 'exists' });
    }
    if (signupMode() === 'invite') invites.consume(invite, email);
    log(`account created ${email}${signupMode() === 'invite' ? ' (invite)' : ''}`);
    return json(res, 200, { ok: true });
  }
  if (path === '/relay/api/logout' && req.method === 'POST') {
    const tok = cookies(req).ateam_rs;
    if (tok) sessions.delete(tok);
    return json(res, 200, { ok: true }, { 'set-cookie': 'ateam_rs=; Path=/; Max-Age=0' });
  }
  if (path === '/relay/api/register-device' && req.method === 'POST') {
    // desktop self-registration with account credentials (creates the account
    // when signup is open and the email is unknown — one step from Settings)
    if (rateLimited(ip)) return json(res, 429, { err: 'locked' });
    const { email, password, name, installationId, invite } = JSON.parse(await readBody(req)) as {
      email?: string;
      password?: string;
      name?: string;
      installationId?: string;
      invite?: string;
    };
    if (!email || !password) return json(res, 400, { err: 'email + password required' });
    if (!store.verifyUser(email, password)) {
      // unknown email + open signup + decent password → create the account
      // in the same step; anything else is a failed login
      if (
        store.hasUser(email) ||
        signupMode() === 'closed' ||
        password.length < 8 ||
        !email.includes('@')
      ) {
        noteFailure(ip);
        return json(res, 401, { err: 'bad credentials' });
      }
      if (signupMode() === 'invite' && !invites.valid(invite)) {
        noteFailure(ip);
        return json(res, 403, {
          err: 'No account with this email. Creating one needs an invite code.',
          needInvite: true,
        });
      }
      store.addUser(email, password);
      if (signupMode() === 'invite') invites.consume(invite, email);
      log(`account created ${email}${signupMode() === 'invite' ? ' (invite)' : ''}`);
    }
    const dev = store.addDevice(email, name ?? 'device', installationId);
    // same installation signing in again: its old token no longer verifies; a
    // tunnel already up on it is replaced when the desktop reconnects with the new one
    log(
      `device ${dev.reused ? 're-registered' : 'registered'} ${dev.id} (${name ?? ''}) for ${email}`,
    );
    return json(res, 200, {
      deviceId: dev.id,
      token: dev.token,
      agentPort: cfg.agentPort,
      accountId: store.accountIdOf(email),
      email: email.trim().toLowerCase(),
    });
  }
  // authed-only endpoints
  const sess = sessionOf(req);
  if (!sess) return json(res, 401, { err: 'sign in first' });
  if (path === '/relay/api/invites' && req.method === 'POST') {
    // a signed-in account may invite others (single use by default)
    const { uses, days } = JSON.parse((await readBody(req)) || '{}') as { uses?: number; days?: number };
    const invite = invites.create(sess.email, Math.min(uses ?? 1, 5), Math.min(days ?? 7, 30));
    log(`invite created by ${sess.email}`);
    return json(res, 200, invite);
  }
  if (path === '/relay/api/devices' && req.method === 'GET') {
    return json(res, 200, { devices: devicesOf(store, sess.email, (id) => agents.has(id)) });
  }
  if (path === '/relay/api/devices/rename' && req.method === 'POST') {
    const { id, name } = JSON.parse(await readBody(req)) as { id?: string; name?: string };
    if (!id || !name || !store.renameDevice(id, sess.email, name))
      return json(res, 404, { err: 'no such device' });
    return json(res, 200, { ok: true });
  }
  if (path === '/relay/api/devices/revoke' && req.method === 'POST') {
    const { id } = JSON.parse(await readBody(req)) as { id?: string };
    if (!id || !store.removeDevice(id, sess.email))
      return json(res, 404, { err: 'no such device' });
    revokeTunnel(id);
    return json(res, 200, { ok: true });
  }
  if (path === '/relay/api/pick' && req.method === 'POST') {
    const { id } = JSON.parse(await readBody(req)) as { id?: string };
    if (!id) return json(res, 200, { ok: true }, { 'set-cookie': 'ateam_dev=; Path=/; Max-Age=0' });
    const d = store.device(id);
    if (!d || d.owner !== sess.email) return json(res, 404, { err: 'no such device' });
    // device online → also hand over its LAN single-sign-on pass so the
    // account login is the ONLY login (the device rotates it per tunnel)
    const lanPass = agents.get(id)?.lanToken;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': [
        `ateam_dev=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
        ...(lanPass
          ? [
              `ateam_lan=${lanPass}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
            ]
          : []),
      ],
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (path === '/relay/api/preview' && req.method === 'POST') {
    // Which LOCAL port this browser wants to see. Kept in a cookie so ONE
    // public port can serve any of them — and cookies ignore the port, so the
    // session set up on the main endpoint is already valid on the preview one.
    if (!cfg.previewPort) return json(res, 501, { err: 'preview is not enabled on this relay' });
    const { port } = JSON.parse(await readBody(req)) as { port?: number };
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    return json(
      res,
      200,
      { ok: true, port: port ?? null, url: port ? `https://${host}:${cfg.previewPort}` : null },
      {
        'set-cookie': port
          ? `ateam_devport=${port}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
          : 'ateam_devport=; Path=/; Max-Age=0',
      },
    );
  }
  json(res, 404, { err: 'unknown endpoint' });
}

// ---------------------------------------------------------------- proxy
/** the device this request may reach, or a page/redirect handled here */
function gate(
  req: IncomingMessage,
  res: ServerResponse | null,
): { agent?: AgentConn; page?: 'login' | 'picker' | 'offline' | 'busy' } {
  const sess = sessionOf(req);
  if (!sess) return { page: 'login' };
  const devId = cookies(req).ateam_dev;
  if (!devId) return { page: 'picker' };
  const d = store.device(devId);
  if (!d || d.owner !== sess.email) {
    if (res) res.setHeader('set-cookie', 'ateam_dev=; Path=/; Max-Age=0');
    return { page: 'picker' };
  }
  const agent = agents.get(devId);
  if (!agent) return { page: 'offline' };
  // "not connected" here was a lie: the machine IS up and the tunnel is full,
  // which is a different thing for the user to do something about — and with a
  // dev server behind the same tunnel (a page is hundreds of requests, not
  // dozens) it is a state they can actually reach.
  if (agent.channelCount >= MAX_CHANNELS_PER_AGENT) return { page: 'busy' };
  return { agent };
}

const PAGES: Record<string, string> = {
  login: LOGIN_HTML,
  picker: PICKER_HTML,
  offline: OFFLINE_HTML,
  busy: BUSY_HTML,
};

const clientSrv = createHttpsServer(tlsOpts, (req, res) => {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (path.startsWith('/sync/api/')) {
    void handleSyncApi(req, res, new URL(req.url ?? '/', 'https://relay'), {
      store,
      sync: syncStore,
      online: (id) => agents.has(id),
      onRevoke: revokeTunnel,
      rateLimited,
      noteFailure,
      createInvite: (email, uses, days) => {
        log(`invite created by ${email}`);
        return invites.create(email, uses, days);
      },
    });
    return;
  }
  // web connectors (ChatGPT / Claude): OAuth with the relay account, then MCP
  // fanned out to that account's machines — see mcp-gateway.ts
  if (isMcpGatewayPath(path)) {
    void mcpGateway.handle(req, res, path);
    return;
  }
  // before the gate: the app's updater carries no login
  if (path.startsWith('/update/')) {
    void handleUpdateApi(req, res, {
      dir: UPDATE_DIR,
      tokenSha256: cfg.updateTokenSha256,
      rateLimited,
      noteFailure,
    });
    return;
  }
  if (path.startsWith('/relay/api/')) {
    void handleApi(req, res, path).catch((e) =>
      json(res, 400, { err: e instanceof Error ? e.message : String(e) }),
    );
    return;
  }
  if (path === '/relay/login') return send(res, 200, 'text/html; charset=utf-8', LOGIN_HTML);
  if (path === '/relay/pick') return send(res, 200, 'text/html; charset=utf-8', PICKER_HTML);
  const g = gate(req, res);
  if (g.page)
    return send(
      res,
      g.page === 'login' ? 401 : 200,
      'text/html; charset=utf-8',
      PAGES[g.page] ?? LOGIN_HTML,
    );
  const agent = g.agent as AgentConn;
  // Self-healing SSO, as a HARD GATE. The device's LAN pass rotates when its
  // config changes, so a stale cookie is re-issued and the navigation retried
  // once. What is new is the floor under it: if that does not converge — or
  // the device never reported a pass at all — we answer with OUR page instead
  // of proxying. The device's own password page must never surface here: it
  // has no way back to the machine picker, and a phone running the home-screen
  // app has no address bar, so one leak strands the user on one machine and
  // cuts off every OTHER machine they own.
  const rawUrl = req.url ?? '/';
  const decision = ssoDecision({
    lanToken: agent.lanToken,
    cookie: cookies(req).ateam_lan ?? '',
    method: req.method ?? 'GET',
    retried: hasRetryMark(rawUrl),
  });
  if (decision === 'blocked') {
    log(`sso blocked device=${agent.id} ${req.method} ${rawUrl.split('?')[0]}`);
    return send(res, 200, 'text/html; charset=utf-8', NO_SSO_HTML);
  }
  if (decision !== 'proxy') {
    const cookie = `ateam_lan=${agent.lanToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
    if (decision === 'redirect') {
      res.writeHead(302, {
        location: markRetry(rawUrl),
        'set-cookie': cookie,
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    res.setHeader('set-cookie', cookie); // 'reissue': not a navigation
  }
  proxyTo(agent, req, res, stripRetry(rawUrl)); // the marker never reaches the device
});

/** One request, one tunnel channel. Node's http client does the framing; we
 *  only supply the transport. `targetPort` asks the device to dial a local
 *  port other than its Ateam server — asking is all it is: the device serves
 *  only ports its user approved and closes the channel otherwise. */
function proxyTo(
  agent: AgentConn,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  targetPort?: number,
): void {
  const headers = { ...req.headers };
  delete headers.connection;
  delete headers['keep-alive'];
  delete headers['proxy-connection'];
  delete headers['transfer-encoding'];
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
  headers['x-forwarded-proto'] = 'https';
  headers.connection = 'close';
  // A dev-server page is a burst of requests over one tunnel, and the odd one
  // comes back transient (502/503/504, or the channel erroring before any
  // response) while the same request succeeds a moment later. Retry those on
  // a FRESH channel — but only GET/HEAD, and only while nothing has been
  // written to the client yet (see proxyRetry). Anything else is proxied once.
  const method = req.method;
  const idempotent = method === 'GET' || method === 'HEAD';
  const maxAttempts = idempotent ? PROXY_MAX_ATTEMPTS : 1;

  const attempt = (n: number): void => {
    if (res.writableEnded || res.destroyed) return;
    const pReq = httpRequest(
      {
        createConnection: () =>
          agent.openStream(targetPort) as unknown as import('node:net').Socket,
        method,
        path,
        headers,
      },
      (pRes) => {
        const status = pRes.statusCode ?? 502;
        const d = proxyRetry({
          method,
          status,
          headersSent: res.headersSent,
          attempt: n,
          maxAttempts,
        });
        if (d.retry) {
          pRes.resume(); // drain and drop this attempt's body
          setTimeout(() => attempt(n + 1), d.delayMs);
          return;
        }
        res.writeHead(status, pRes.headers);
        pRes.pipe(res);
      },
    );
    pReq.on('error', () => {
      const d = proxyRetry({
        method,
        status: undefined, // transport error: no response at all
        headersSent: res.headersSent,
        attempt: n,
        maxAttempts,
      });
      if (d.retry) {
        setTimeout(() => attempt(n + 1), d.delayMs);
        return;
      }
      if (!res.headersSent) send(res, 502, 'text/html; charset=utf-8', OFFLINE_HTML);
      else res.destroy();
    });
    // GET/HEAD carry no body to replay, so end the request ourselves and keep
    // it retryable; anything else streams its body through once.
    if (idempotent) pReq.end();
    else req.pipe(pReq);
  };

  attempt(1);
}

// WebSocket / any Upgrade: authenticate, then splice raw bytes both ways
clientSrv.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const g = gate(req, null);
  // An upgrade carries the same cookie, and there is no redirect to converge it
  // with — so a stale one used to reach the device, which rejected the socket:
  // the phone showed a bare "websocket error" and nothing explained it. Refuse
  // it here instead; the client's reload goes through the HTTP path above,
  // which knows how to re-issue the pass.
  const ssoOk = !!g.agent?.lanToken && cookies(req).ateam_lan === g.agent.lanToken;
  if (g.page || !g.agent || !ssoOk) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const stream = g.agent.openStream();
  // reconstruct the upgrade request head for the device's server
  let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
  raw += '\r\n';
  stream.write(raw);
  if (head.length) stream.write(head);
  socket.pipe(stream);
  stream.pipe(socket);
  const kill = (): void => {
    stream.destroy();
    socket.destroy();
  };
  socket.on('error', kill);
  stream.on('error', kill);
  stream.on('close', () => socket.destroy());
  socket.on('close', () => stream.destroy());
});
clientSrv.on('tlsClientError', () => {
  /* probes / self-signed rejections — noise */
});
clientSrv.requestTimeout = 30 * 60 * 1000;
clientSrv.listen(cfg.clientPort, '0.0.0.0', () =>
  log(`client endpoint https://0.0.0.0:${cfg.clientPort}`),
);

// ------------------------------------------------------- preview endpoint
/**
 * A device's LOCAL WEB SERVER, on its own public port.
 *
 * Its own port rather than a path under the main one, because a dev server
 * owns its origin: every `/assets/...`, every HMR socket, every redirect is
 * absolute, and a path prefix breaks all of them. Its own port rather than a
 * subdomain, because cookies ignore ports — the session and device cookies
 * set on the main endpoint arrive here already valid, and no wildcard
 * certificate or DNS record is needed for any of it.
 *
 * The gate is the same one the Ateam UI goes through: signed in, and this
 * device belongs to you. What is NOT here is any say over the target — the
 * cookie names a port, the device decides whether it was approved.
 */
if (cfg.previewPort) {
  const previewTarget = (req: IncomingMessage): number | undefined => {
    const n = Number(cookies(req).ateam_devport);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
  };
  const previewSrv = createHttpsServer(tlsOpts, (req, res) => {
    const g = gate(req, res);
    if (g.page)
      return send(
        res,
        g.page === 'login' ? 401 : 200,
        'text/html; charset=utf-8',
        PAGES[g.page] ?? LOGIN_HTML,
      );
    const port = previewTarget(req);
    if (!port) return send(res, 200, 'text/html; charset=utf-8', NO_PREVIEW_HTML);
    proxyTo(g.agent as AgentConn, req, res, req.url ?? '/', port);
  });
  // HMR lives on a websocket; without this a dev server reloads by hand only
  previewSrv.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const g = gate(req, null);
    const port = previewTarget(req);
    if (g.page || !g.agent || !port) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const stream = g.agent.openStream(port);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    raw += '\r\n';
    stream.write(raw);
    if (head.length) stream.write(head);
    socket.pipe(stream);
    stream.pipe(socket);
    const kill = (): void => {
      stream.destroy();
      socket.destroy();
    };
    socket.on('error', kill);
    stream.on('error', kill);
    stream.on('close', () => socket.destroy());
    socket.on('close', () => stream.destroy());
  });
  previewSrv.on('tlsClientError', () => {
    /* probes — noise */
  });
  previewSrv.listen(cfg.previewPort, '0.0.0.0', () =>
    log(`preview endpoint https://0.0.0.0:${cfg.previewPort}`),
  );
}

// ---------------------------------------------------------------- agents
const agentHttp = createHttpsServer(tlsOpts, (_req, res) => {
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('ateam relay — agent endpoint (WebSocket upgrade expected)\n');
});
const wss = new WebSocketServer({ server: agentHttp, path: '/agent', maxPayload: 4 * 1024 * 1024 });
wss.on('connection', (ws, req) => {
  let agent: AgentConn | undefined;
  let alive = true;
  const authTimer = setTimeout(() => {
    if (!agent) ws.close(4001, 'auth timeout');
  }, 10_000);
  const ping = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, PING_MS);
  ws.on('pong', () => {
    alive = true;
  });
  ws.on('message', (rawMsg) => {
    let m: {
      t?: string;
      ch?: string;
      d?: string;
      device?: string;
      token?: string;
      lanToken?: string;
      caps?: unknown;
    };
    try {
      m = JSON.parse(String(rawMsg));
    } catch {
      return;
    }
    if (!agent) {
      if (m.t !== 'auth' || !m.device || !m.token) {
        ws.close(4001, 'auth required');
        return;
      }
      if (!store.verifyDeviceToken(m.device, m.token)) {
        log(`agent auth failed device=${m.device} from ${req.socket.remoteAddress}`);
        ws.close(4003, 'bad device/token');
        return;
      }
      clearTimeout(authTimer);
      // Two processes holding the same device token take turns kicking each
      // other off and reconnecting at once — 6854 up/down in an hour, and the
      // phone hitting a different tunnel on every request (2026-08-27). Newer
      // still wins, but a device that keeps replacing itself is parked.
      if (!flap.accept(m.device, Date.now())) {
        log(`agent parked device=${m.device} — replacing itself too fast (a second copy running?)`);
        ws.close(4008, 'too many reconnects — another copy of Ateam may be running');
        return;
      }
      agents.get(m.device)?.ws.close(4000, 'replaced by a newer connection');
      agent = new AgentConn(
        m.device,
        ws,
        typeof m.lanToken === 'string' ? m.lanToken.slice(0, 128) : '',
        new Set(Array.isArray(m.caps) ? m.caps.filter((c): c is string => c === 'mcp') : []),
      );
      agents.set(m.device, agent);
      store.touchDevice(m.device);
      ws.send(JSON.stringify({ t: 'ok', device: m.device, clientPort: cfg.clientPort }));
      log(
        `agent up device=${m.device} (${store.device(m.device)?.name ?? ''}) from ${req.socket.remoteAddress}`,
      );
      return;
    }
    if (m.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong' }));
      return;
    }
    if (m.ch) agent.onFrame(m as { ch: string; t?: string; d?: string });
  });
  ws.on('close', () => {
    clearInterval(ping);
    clearTimeout(authTimer);
    if (!agent) return;
    agent.destroy();
    if (agents.get(agent.id) === agent) agents.delete(agent.id);
    store.touchDevice(agent.id);
    log(`agent down device=${agent.id}`);
  });
});
agentHttp.listen(cfg.agentPort, '0.0.0.0', () =>
  log(`agent endpoint wss://0.0.0.0:${cfg.agentPort}/agent`),
);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
