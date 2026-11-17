import { WebSocket } from 'ws';
import { type Handshake, readHandshake } from './handshake';
import type { Port } from './port';
import { WsPort } from './ws-port';

/**
 * Connect to the local server. With no args, reads the handshake file written
 * by the daemon; otherwise uses the explicit port/token.
 */
export function connectWs(opts?: { port?: number; token?: string }): Promise<Port> {
  const hs: Handshake =
    opts?.port !== undefined && opts?.token !== undefined
      ? { port: opts.port, token: opts.token, pid: 0 }
      : readHandshake();
  const ws = new WebSocket(`ws://127.0.0.1:${hs.port}/?token=${hs.token}`);

  return new Promise<Port>((resolve, reject) => {
    let opened = false;
    ws.once('open', () => {
      opened = true;
      resolve(new WsPort(ws));
    });
    ws.once('error', reject);
    ws.once('close', (code: number) => {
      if (!opened) reject(new Error(`ws closed before open (code ${code})`));
    });
  });
}
