import { type IncomingMessage, type Server, createServer, request as httpRequest } from 'node:http';
import { type Socket, connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * A loopback reverse proxy in front of ONE local dev server, for the relay
 * preview path.
 *
 * Why it exists: the relay hands the desktop the browser's request as-is, so
 * the dev server sees `Host: relay.example.com`. Vite (since 5.4.12 / 6.0.9),
 * and increasingly others, refuse any Host that is not localhost or an IP —
 * DNS-rebinding protection — and answer with "Blocked request. This host is
 * not allowed". Editing every project's `server.allowedHosts` is the wrong
 * side to fix it on; the desktop knows it is talking to its own loopback and
 * can say so. So every hop through here carries `Host: localhost:<port>`,
 * which every such check allows by default.
 *
 * Plain requests go through node:http, which keeps HTTP framing and
 * keep-alive correct without parsing anything by hand. Upgrades (HMR lives
 * on a websocket) are re-serialised from rawHeaders with the same Host swap
 * and then piped raw both ways.
 */
export interface PreviewProxy {
  /** loopback port the tunnel should dial instead of the dev server */
  readonly port: number;
  /** the dev-server host this proxy fronts (127.0.0.1 or ::1) */
  readonly host: string;
  close(): void;
}

/** The Host a local dev server is told it was reached by. */
export function loopbackHost(port: number): string {
  return `localhost:${port}`;
}

/** Request head for an upgrade, re-serialised with the Host rewritten and
 *  everything else — order, casing, duplicates — kept as it arrived. */
export function rewriteUpgradeHead(req: IncomingMessage, targetPort: number): string {
  let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  const h = req.rawHeaders;
  for (let i = 0; i < h.length; i += 2) {
    const name = h[i] ?? '';
    const value = h[i + 1] ?? '';
    raw += `${name}: ${name.toLowerCase() === 'host' ? loopbackHost(targetPort) : value}\r\n`;
  }
  return `${raw}\r\n`;
}

export function startPreviewProxy(target: { port: number; host: string }): Promise<PreviewProxy> {
  const srv: Server = createServer((req, res) => {
    const up = httpRequest(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: loopbackHost(target.port) },
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('the local server stopped answering');
    });
    req.pipe(up);
  });
  srv.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const up: Socket = netConnect(target.port, target.host, () => {
      up.write(rewriteUpgradeHead(req, target.port));
      if (head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    const kill = (): void => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', kill);
    socket.on('error', kill);
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        host: target.host,
        close: () => {
          srv.closeAllConnections?.();
          srv.close();
        },
      });
    });
  });
}
