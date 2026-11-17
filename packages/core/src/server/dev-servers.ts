import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';

/**
 * Local HTTP servers worth previewing from a phone.
 *
 * The point of discovery is that the person previewing usually does NOT know
 * the port: an agent started the dev server, and the person is on their phone.
 * So this enumerates what is listening and asks each candidate whether it
 * speaks HTTP, rather than guessing from process names — which is also what
 * makes it work for any stack (vite, uvicorn, Go, PHP, Rails), not just the
 * ones we thought to name.
 */
export interface DevServer {
  port: number;
  /** process that owns the socket, for the picker's label */
  process: string;
  /** Which loopback address actually answered. Node dev servers bound to
   *  "localhost" on a modern Node end up IPv6-ONLY: vite here listens on
   *  [::1]:5199 and 127.0.0.1 refuses the connection outright. Whoever dials
   *  the tunnel must use the address that answered, or the most common dev
   *  server on the machine is the one it cannot reach. */
  host: '127.0.0.1' | '::1';
  /** <title> of the served page, when it has one — the fastest way to tell
   *  two projects apart in a list */
  title?: string;
}

/**
 * Whether a reply looks like a web app worth previewing.
 *
 * Every local app that ships an HTTP listener answers SOMETHING — on this
 * machine QQ, QQMusic, Control Center, clash and Figma's agent all did. What
 * separates them from a dev server is the pair below: they answer 401/403/404/
 * 426, or a 200 with no content type at all; a dev server answers OK with
 * html. Judging by the reply rather than the process name is also what keeps
 * this working for stacks nobody thought to name.
 */
export function isPreviewable(status: number, contentType = ''): boolean {
  if (status < 200 || status >= 400) return false;
  return contentType.toLowerCase().includes('text/html');
}

/** Ports that answer on localhost but must never be offered: exposing one
 *  through the relay would put a database on the public internet behind a
 *  single cookie. Not a guess — an explicit deny list. */
export const INFRA_PORTS = new Set([
  5432, // postgres
  3306, // mysql/mariadb
  6379, // redis
  27017, // mongodb
  11211, // memcached
  9200, // elasticsearch
  5984, // couchdb
  1433, // sql server
  0,
]);

/** Whether a listening port may be offered for preview at all. */
export function isPreviewCandidate(port: number, own: readonly number[] = []): boolean {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return false;
  if (INFRA_PORTS.has(port)) return false;
  // our own listeners: the LAN server and the desktop's RPC socket. Tunnelling
  // Ateam into Ateam is a loop, not a preview.
  if (own.includes(port)) return false;
  return true;
}

/** `lsof` one line per listening TCP socket → {port, process}. Best-effort:
 *  no lsof, no permission, no discovery — the picker just comes back empty. */
export function listListeners(): Promise<{ port: number; process: string }[]> {
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN'],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve([]);
        const out = new Map<number, string>();
        for (const line of stdout.split('\n').slice(1)) {
          const cols = line.split(/\s+/);
          const name = cols[0];
          const addr = cols[8];
          if (!name || !addr) continue;
          const port = Number(addr.slice(addr.lastIndexOf(':') + 1));
          if (!Number.isInteger(port)) continue;
          if (!out.has(port)) out.set(port, name);
        }
        resolve([...out].map(([port, process]) => ({ port, process })));
      },
    );
  });
}

/** GET / on one loopback address. Resolves with the page title (or '' when
 *  it has none) for something previewable, and undefined for everything else
 *  — no answer, not html, an error status. */
export function probeHttp(
  port: number,
  host: '127.0.0.1' | '::1',
  timeoutMs = 500,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const req = httpRequest({ host, port, method: 'GET', path: '/', timeout: timeoutMs }, (res) => {
      if (!isPreviewable(res.statusCode ?? 0, res.headers['content-type'] ?? '')) {
        res.destroy();
        resolve(undefined);
        return;
      }
      let body = '';
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve(/<title[^>]*>([^<]{1,80})</i.exec(body)?.[1]?.trim() ?? '');
      };
      res.on('data', (c: Buffer) => {
        body += c.toString('utf8');
        if (body.length > 8192) {
          res.destroy(); // the <title> is near the top; don't pull a whole page
          done();
        }
      });
      res.on('end', done);
      res.on('close', done);
      res.on('error', done);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.on('error', () => resolve(undefined));
    req.end();
  });
}

/** Everything on this machine that a phone could usefully preview. Both
 *  loopback families are tried — see DevServer.host. */
export async function discoverDevServers(own: readonly number[] = []): Promise<DevServer[]> {
  const listeners = (await listListeners()).filter((l) => isPreviewCandidate(l.port, own));
  const probed = await Promise.all(
    listeners.map(async (l): Promise<DevServer | undefined> => {
      for (const host of ['127.0.0.1', '::1'] as const) {
        const title = await probeHttp(l.port, host);
        if (title === undefined) continue;
        return { ...l, host, ...(title ? { title } : {}) };
      }
      return undefined;
    }),
  );
  return probed.filter((x): x is DevServer => !!x).sort((a, b) => a.port - b.port);
}
