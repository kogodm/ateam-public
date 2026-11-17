import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import type { Port } from './port';
import { WsPort } from './ws-port';

export interface LanServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

export interface LanServerOpts {
  /** TCP port to bind on all interfaces (0 = ephemeral, for tests). */
  port: number;
  /** Directory holding the built desktop UI (index.html + assets). When it
   *  doesn't exist, authenticated pages get a plain "UI not bundled" note —
   *  the RPC WebSocket still works. */
  uiDir?: string;
  /** Password check — the caller owns storage/hashing (scrypt in core). */
  verifyPassword: (candidate: string) => boolean;
  /** Tunnel single-sign-on: a cookie value the RELAY hands to clients that
   *  already signed in to their account and picked this device — accepted as
   *  a valid session so they skip the password page. The token rotates per
   *  tunnel connection; '' disables the bypass. */
  verifyTunnelToken?: (token: string) => boolean;
  /** One authenticated RPC client connected over /ws. */
  onConnection: (port: Port) => void;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_MS = 30_000;
const MAX_BODY_BYTES = 4096;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Minimal self-contained login page. Served to any unauthenticated request
 *  so nothing of the real UI (or whether it exists) leaks before auth. */
const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ateam</title><style>
html,body{margin:0;height:100%;background:#101014;color:#e8e8ec;font:15px/1.5 -apple-system,'Segoe UI',sans-serif}
.wrap{display:flex;align-items:center;justify-content:center;height:100%}
form{background:#17171d;border:1px solid #2a2a33;border-radius:12px;padding:32px 28px;width:300px;display:flex;flex-direction:column;gap:12px}
h1{font-size:17px;margin:0 0 4px;font-weight:600}h1 span{opacity:.55;font-weight:400}
input{background:#101014;border:1px solid #33333d;border-radius:8px;color:inherit;padding:10px 12px;font-size:15px;outline:none}
input:focus{border-color:#5a5af0}
button{background:#5a5af0;border:0;border-radius:8px;color:#fff;padding:10px;font-size:15px;cursor:pointer}
button:disabled{opacity:.5}
.err{color:#ff7676;font-size:13px;min-height:18px;margin:0}
</style></head><body><div class="wrap">
<form id="f"><h1>◇ ATEAM <span>· LAN access</span></h1>
<input id="p" type="password" placeholder="Password" autofocus autocomplete="current-password">
<button id="b" type="submit">Unlock</button><p class="err" id="e"></p></form></div>
<script>
const f=document.getElementById('f'),p=document.getElementById('p'),b=document.getElementById('b'),e=document.getElementById('e');
f.addEventListener('submit',async(ev)=>{ev.preventDefault();b.disabled=true;e.textContent='';
try{const r=await fetch('/lan/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:p.value})});
if(r.ok){location.reload();return}
e.textContent=r.status===429?'Too many attempts — wait 30s':'Wrong password';
}catch{e.textContent='Network error'}
b.disabled=false});
</script></body></html>`;

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * HTTP + WebSocket server for LAN access: serves the built desktop UI and
 * the contract RPC socket on all interfaces, behind a password.
 *
 * Auth model: POST /lan/login {password} → HttpOnly session cookie (random
 * token, in-memory, 7-day TTL — a restart logs everyone out). Every other
 * route answers the login page until the cookie is valid; /ws upgrades only
 * with a valid cookie. Login attempts are rate-limited per source IP.
 *
 * This is plain HTTP — the password and everything after it are readable by
 * anyone on the same network path. Only for networks the user trusts; the
 * Settings UI says so and the feature is off by default.
 */
export function startLanServer(opts: LanServerOpts): Promise<LanServerHandle> {
  // token → expiry epoch-ms
  const sessions = new Map<string, number>();
  // ip → { fails, lockedUntil }
  const attempts = new Map<string, { fails: number; lockedUntil: number }>();

  function isAuthed(req: IncomingMessage): boolean {
    const token = parseCookies(req).ateam_lan;
    if (!token) return false;
    if (opts.verifyTunnelToken?.(token)) return true;
    const exp = sessions.get(token);
    if (!exp) return false;
    if (Date.now() > exp) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function send(res: ServerResponse, status: number, type: string, body: string): void {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? '?';
    const a = attempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
    if (Date.now() < a.lockedUntil) {
      send(res, 429, 'application/json', '{"ok":false,"error":"locked"}');
      return;
    }
    let password = '';
    try {
      password = String((JSON.parse(await readBody(req)) as { password?: unknown }).password ?? '');
    } catch {
      send(res, 400, 'application/json', '{"ok":false,"error":"bad request"}');
      return;
    }
    if (!opts.verifyPassword(password)) {
      a.fails += 1;
      if (a.fails >= MAX_LOGIN_FAILURES) {
        a.fails = 0;
        a.lockedUntil = Date.now() + LOCKOUT_MS;
      }
      attempts.set(ip, a);
      send(res, 403, 'application/json', '{"ok":false,"error":"wrong password"}');
      return;
    }
    attempts.delete(ip);
    const token = randomBytes(24).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `ateam_lan=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      'cache-control': 'no-store',
    });
    res.end('{"ok":true}');
  }

  function serveStatic(pathname: string, res: ServerResponse): void {
    const uiDir = opts.uiDir;
    if (!uiDir || !existsSync(join(uiDir, 'index.html'))) {
      send(
        res,
        200,
        'text/html; charset=utf-8',
        '<!doctype html><meta charset="utf-8"><body style="background:#101014;color:#e8e8ec;font-family:sans-serif;padding:40px">Ateam UI assets are not bundled in this build — rebuild the app with the LAN feature, or use the desktop window.</body>',
      );
      return;
    }
    // sanitize: resolve inside uiDir only, no traversal
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\]|\.\.([/\\]|$))+/, '');
    let file = join(uiDir, rel);
    if (!file.startsWith(uiDir + sep) && file !== uiDir) file = join(uiDir, 'index.html');
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(uiDir, 'index.html'); // SPA fallback
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // hashed asset names are immutable; index.html must revalidate
      'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=86400',
    });
    createReadStream(file).pipe(res);
  }

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'POST' && pathname === '/lan/login') {
      void handleLogin(req, res);
      return;
    }
    if (!isAuthed(req)) {
      send(res, 200, 'text/html; charset=utf-8', LOGIN_HTML);
      return;
    }
    serveStatic(pathname, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/ws' || !isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      opts.onConnection(new WsPort(ws));
    });
  });

  return new Promise<LanServerHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '0.0.0.0', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            wss.close();
            // close idle keep-alive sockets too, or close() hangs for minutes
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}
