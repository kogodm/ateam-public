import type { CloseHandler, MessageHandler, Port } from './port';

/**
 * A pair of linked in-process Ports. Used by the embedded TUI (core runs in
 * the same process, no socket) and by tests. Messages are structured-cloned
 * and delivered on a microtask so behavior matches an async transport.
 */
class InprocPort implements Port {
  private peer: InprocPort | undefined;
  private readonly msgCbs = new Set<MessageHandler>();
  private readonly closeCbs = new Set<CloseHandler>();
  private closed = false;

  link(peer: InprocPort): void {
    this.peer = peer;
  }

  send(msg: unknown): void {
    if (this.closed || !this.peer) return;
    const clone = structuredClone(msg);
    const peer = this.peer;
    queueMicrotask(() => {
      for (const cb of peer.msgCbs) cb(clone);
    });
  }

  onMessage(cb: MessageHandler): () => void {
    this.msgCbs.add(cb);
    return () => this.msgCbs.delete(cb);
  }

  onClose(cb: CloseHandler): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb();
    this.peer?.close();
  }
}

export function createInprocPair(): { client: Port; server: Port } {
  const a = new InprocPort();
  const b = new InprocPort();
  a.link(b);
  b.link(a);
  return { client: a, server: b };
}
