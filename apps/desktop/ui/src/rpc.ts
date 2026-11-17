/**
 * Browser-native RPC client speaking the frozen @ateam/contract envelope
 * over the loopback WebSocket the sidecar hosts. No Node deps — the same
 * core the TUI drives, reached from the webview. Handshake comes from the
 * Tauri shell (`get_handshake`), or `?port=&token=` when running the UI in
 * a plain browser against `ateam serve` (dev).
 */
import { PROTOCOL_VERSION } from '@ateam/contract';
import type {
  EventData,
  EventTopic,
  MethodName,
  Params,
  ProtocolError,
  Result,
} from '@ateam/contract';

interface Handshake {
  port: number;
  token: string;
}

async function tauriHandshake(): Promise<Handshake | null> {
  if (!('isTauri' in window) || !window.isTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  // the sidecar may need a moment to print its handshake
  for (let i = 0; i < 100; i++) {
    const hs = await invoke<Handshake | null>('get_handshake').catch(() => null);
    if (hs && hs.port) return hs;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

function urlHandshake(): Handshake | null {
  const q = new URLSearchParams(location.search);
  const port = Number(q.get('port'));
  const token = q.get('token');
  return port && token ? { port, token } : null;
}

export interface Rpc {
  request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>;
  on<T extends EventTopic>(topic: T, cb: (data: EventData<T>) => void): () => void;
  onClose(cb: () => void): void;
}

export async function connect(): Promise<Rpc> {
  const hs = (await tauriHandshake()) ?? urlHandshake();
  // LAN access: the page came from the sidecar's own HTTP server (no Tauri,
  // no ?port&token) — the RPC socket lives at /ws on the same origin, and
  // auth rides on the HttpOnly cookie the login page set.
  const wsUrl = hs
    ? `ws://127.0.0.1:${hs.port}/?token=${hs.token}`
    : location.protocol.startsWith('http')
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
      : null;
  if (!wsUrl) throw new Error('no handshake (sidecar not ready / missing ?port&token)');

  const ws = new WebSocket(wsUrl);
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const closeCbs = new Set<() => void>();
  let seq = 0;

  ws.onmessage = (ev) => {
    let msg: {
      kind?: string;
      id?: string;
      ok?: boolean;
      result?: unknown;
      error?: ProtocolError;
      topic?: string;
      data?: unknown;
    };
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    if (msg.kind === 'res' && msg.id) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      // carry the error CODE, not just its text: callers branch on it (a wake
      // refused because the conversation is running as a background agent
      // offers to fork instead). Dropping it turned that into a dead-end
      // "wake failed: …" line with no way forward.
      else
        p.reject(
          Object.assign(new Error(msg.error?.message ?? 'rpc error'), {
            code: msg.error?.code,
          }),
        );
    } else if (msg.kind === 'evt' && msg.topic) {
      for (const cb of listeners.get(msg.topic) ?? []) cb(msg.data);
    }
  };
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('connection closed'));
    pending.clear();
    for (const cb of closeCbs) cb();
  };

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('websocket error'));
  });

  return {
    request(method, params) {
      const id = `r${seq++}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'req', id, method, params }));
      });
    },
    on(topic, cb) {
      const set = listeners.get(topic) ?? new Set();
      set.add(cb as (d: unknown) => void);
      listeners.set(topic, set);
      return () => set.delete(cb as (d: unknown) => void);
    },
    onClose(cb) {
      closeCbs.add(cb);
    },
  };
}

declare global {
  interface Window {
    isTauri?: boolean;
  }
}
