import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import type { Port } from './port';
import { type Handshake, writeHandshake } from './handshake';
import { WsPort } from './ws-port';

export interface WsServerHandle {
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

/**
 * Start a loopback WebSocket server on an ephemeral port with a per-launch
 * bearer token. Writes a handshake file so the TUI/CLI/Tauri can connect.
 * `onConnection` receives one Port per authenticated client.
 */
export function startWsServer(
  onConnection: (port: Port) => void,
  opts: { writeHandshakeFile?: boolean } = {},
): Promise<WsServerHandle> {
  const token = randomBytes(24).toString('hex');
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    // Reject unauthorized clients at the HTTP upgrade handshake — they never
    // reach an open WebSocket (correct security posture + lets clients fail).
    verifyClient: (info: { req: IncomingMessage }) => {
      const url = new URL(info.req.url ?? '/', 'http://localhost');
      const auth = info.req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const provided = url.searchParams.get('token') ?? auth ?? '';
      return provided === token;
    },
  });

  return new Promise<WsServerHandle>((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const handshake: Handshake = { port, token, pid: process.pid };
      if (opts.writeHandshakeFile !== false) writeHandshake(handshake);
      resolve({
        port,
        token,
        close: () =>
          new Promise<void>((res) => {
            wss.close(() => res());
          }),
      });
    });

    wss.on('connection', (ws) => {
      onConnection(new WsPort(ws));
    });
  });
}
