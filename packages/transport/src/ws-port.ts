import type { WebSocket } from 'ws';
import type { CloseHandler, MessageHandler, Port } from './port';

/** Wraps a `ws` WebSocket as a Port. Shared by ws-server and ws-client. */
export class WsPort implements Port {
  constructor(private readonly ws: WebSocket) {}

  send(msg: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(cb: MessageHandler): () => void {
    const handler = (data: unknown): void => {
      try {
        cb(JSON.parse(String(data)));
      } catch {
        /* ignore malformed frame; protocol layer validates */
      }
    };
    this.ws.on('message', handler);
    return () => this.ws.off('message', handler);
  }

  onClose(cb: CloseHandler): () => void {
    this.ws.on('close', cb);
    return () => this.ws.off('close', cb);
  }

  close(): void {
    this.ws.close();
  }
}
