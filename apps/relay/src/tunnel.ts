import { randomBytes } from 'node:crypto';
import { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';

/** One connected desktop and its multiplexed channels. The wire protocol is
 *  unchanged from v1 (the desktop's RelayClient needs no update):
 *    relay → agent : {ch,t:'open'} {ch,t:'data',d:base64} {ch,t:'close'}
 *    agent → relay : {ch,t:'data',d} {ch,t:'close'} (+ {t:'ping'})
 *  Each channel is exposed here as a Duplex so Node's own http client can
 *  speak HTTP through it (createConnection: () => agent.openStream()). */
export class AgentConn {
  private readonly streams = new Map<string, ChannelStream>();
  constructor(
    readonly id: string,
    readonly ws: WebSocket,
    /** LAN single-sign-on pass minted by the desktop for this connection —
     *  handed to clients as their ateam_lan cookie when they pick the device */
    readonly lanToken: string = '',
    /** what the desktop said it serves beyond its UI ('mcp' = external MCP channel) */
    readonly caps: ReadonlySet<string> = new Set(),
  ) {}

  get channelCount(): number {
    return this.streams.size;
  }

  /** Open a channel to the device. `port` asks it to dial a LOCAL port other
   *  than its Ateam server — a dev-server preview. Asking is all we do: the
   *  device answers only for a port its user approved, and closes the channel
   *  otherwise, so nothing here can name a target on someone's machine. */
  openStream(port?: number, target?: 'mcp'): ChannelStream {
    const ch = randomBytes(8).toString('hex');
    const stream = new ChannelStream(this, ch);
    this.streams.set(ch, stream);
    this.send({ ch, t: 'open', ...(port ? { port } : {}), ...(target ? { target } : {}) });
    return stream;
  }

  /** frame from the agent for one of our channels */
  onFrame(m: { ch: string; t?: string; d?: string }): void {
    const s = this.streams.get(m.ch);
    if (!s) return;
    if (m.t === 'data' && m.d) s.pushData(Buffer.from(m.d, 'base64'));
    else if (m.t === 'close') {
      this.streams.delete(m.ch);
      s.endFromRemote();
    }
  }

  send(frame: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(frame));
  }

  closeStream(ch: string, notify: boolean): void {
    if (this.streams.delete(ch) && notify) this.send({ ch, t: 'close' });
  }

  destroy(): void {
    for (const s of [...this.streams.values()]) s.destroy();
    this.streams.clear();
  }
}

/** A tunnel channel as a Duplex: write → data frame; agent data → readable. */
export class ChannelStream extends Duplex {
  private remoteEnded = false;
  constructor(
    private readonly agent: AgentConn,
    private readonly ch: string,
  ) {
    super({ allowHalfOpen: false });
  }

  pushData(buf: Buffer): void {
    this.push(buf);
  }

  endFromRemote(): void {
    if (this.remoteEnded) return;
    this.remoteEnded = true;
    this.push(null);
  }

  override _read(): void {
    /* push-driven */
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.agent.send({ ch: this.ch, t: 'data', d: chunk.toString('base64') });
    cb();
  }

  override _final(cb: (e?: Error | null) => void): void {
    this.agent.closeStream(this.ch, true);
    cb();
  }

  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    this.agent.closeStream(this.ch, !this.remoteEnded);
    cb(err);
  }
}
