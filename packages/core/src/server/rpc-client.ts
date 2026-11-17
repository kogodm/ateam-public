import { randomUUID } from 'node:crypto';
import { type Envelope, PROTOCOL_VERSION, parseEnvelope } from '@ateam/contract';
import type { Port } from '@ateam/transport';

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
type Listener = (data: unknown) => void;

/** Minimal contract client with request/response correlation + event subs.
 *  Used by the TUI (embedded inproc Port now, ws later) — Tauri reuses it. */
export class RpcClient {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly port: Port) {
    port.onMessage((raw) => {
      let env: Envelope;
      try {
        env = parseEnvelope(raw);
      } catch {
        return;
      }
      if (env.kind === 'res') {
        const p = this.pending.get(env.id);
        if (!p) return;
        this.pending.delete(env.id);
        if (env.ok) p.resolve(env.result);
        else p.reject(Object.assign(new Error(env.error.message), { code: env.error.code }));
      } else if (env.kind === 'evt') {
        const set = this.listeners.get(env.topic);
        if (set) for (const cb of set) cb(env.data);
      }
    });
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.send({ v: PROTOCOL_VERSION, kind: 'req', id, method, params });
    });
  }

  on<T = unknown>(topic: string, cb: (data: T) => void): () => void {
    const set = this.listeners.get(topic) ?? new Set<Listener>();
    set.add(cb as Listener);
    this.listeners.set(topic, set);
    return () => set.delete(cb as Listener);
  }
}
