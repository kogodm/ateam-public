import { createHash } from 'node:crypto';
import { type Socket, connect as netConnect } from 'node:net';
import { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { WebSocket } from 'ws';
import { loadConfig } from '../config';
import { normalizeFingerprint } from './fingerprint';
import { type PreviewProxy, startPreviewProxy } from './preview-proxy';
import { clearTunnelToken, setTunnelToken } from './tunnel-auth';

/**
 * Agent side of the self-hosted relay (apps/relay): dials OUT to the relay's
 * agent endpoint, authenticates with this device's token, then for every
 * channel the relay opens it connects to the LOCAL LAN server
 * (127.0.0.1:<lan port>) and pipes bytes both ways. The relay is what the
 * phone talks to; the LAN server's login page / password / UI / RPC socket do
 * the rest, unchanged. Reconnects with backoff; mutes when disabled.
 *
 * Frames: {ch,t:'open'} {ch,t:'data',d:base64} {ch,t:'close'} + {t:'ping'/'pong'}.
 */
export interface RemoteStatus {
  enabled: boolean;
  connected: boolean;
  /** what the relay reported on auth: the public client port */
  clientPort?: number;
  url: string;
  deviceId: string;
  lastError?: string;
  since?: string;
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
export const PING_MS = 20_000;
/** No word from the relay for this long ⇒ the tunnel is dead even though the
 *  socket still looks open. Switching networks (Wi-Fi → hotspot, a new DHCP
 *  lease) kills the TCP connection without a FIN, so Node keeps reporting an
 *  OPEN socket, the desktop keeps showing "connected", and the phone sees the
 *  device offline — the exact report this guards against. Must exceed two
 *  ping intervals so a single lost packet never forces a reconnect. */
export const DEAD_MS = 55_000;

/** Close codes the relay uses to say something a reconnect cannot fix. */
export const RELAY_CLOSE = { replaced: 4000, badToken: 4003, parked: 4008 } as const;

export type CloseAction = 'retry' | 'slow-retry' | 'stand-down';

/**
 * What to do when the relay hangs up.
 *
 * `replaced` is the one that matters: another PROCESS authenticated as this
 * machine. Reconnecting takes the slot straight back, that process does the
 * same, and the two trade the tunnel twice a second forever — a phone then
 * lands on a different tunnel per request, which is how a duplicate desktop
 * instance made remote access unusable (2026-08-27: 6854 up/down in an hour).
 * Standing down leaves ONE owner. Settings' toggle or an app restart revives
 * this one if it should be the owner instead.
 */
/**
 * Where a channel the relay just opened should be dialled.
 *
 * Pure because this is the security boundary. The relay may ASK for a port,
 * but it never gets to name a target: only a port the user approved on this
 * machine resolves, so a hand-edited cookie naming postgres resolves to
 * 'refuse' and the channel is closed instead of connected.
 */
export type Dial = { kind: 'lan' } | { kind: 'preview'; port: number } | { kind: 'refuse' };

export function previewDial(args: {
  /** port the relay put on the open frame, if any */
  framePort: number | undefined;
  lanPort: number;
  /** approved preview ports (a set of keys — a live proxy per port) */
  approved: ReadonlyMap<number, unknown>;
}): Dial {
  const { framePort, lanPort, approved } = args;
  if (typeof framePort !== 'number' || framePort === lanPort) return { kind: 'lan' };
  return approved.has(framePort) ? { kind: 'preview', port: framePort } : { kind: 'refuse' };
}

export function closeAction(code: number): CloseAction {
  if (code === RELAY_CLOSE.replaced) return 'stand-down';
  if (code === RELAY_CLOSE.parked) return 'slow-retry';
  return 'retry';
}

export class RelayClient {
  private ws?: WebSocket;
  private channels = new Map<string, Pick<Socket, 'write' | 'end' | 'destroy'>>();
  /** External MCP requests the relay forwards for web connectors ('mcp' channels). */
  constructor(private readonly mcpHandler?: (stream: Duplex) => void) {}
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pinger?: ReturnType<typeof setInterval>;
  private stopped = true;
  private connected = false;
  private clientPort?: number;
  private since?: string;
  private lastError = '';
  /** when the relay last said ANYTHING (auth ok, pong, channel traffic) */
  private lastSeen = 0;
  /**
   * Approved preview ports → the loopback proxy the tunnel dials for each.
   *
   * ONE map, and the proxy is the authorization: a port lands here only once
   * its Host-rewriting proxy (preview-proxy.ts) is listening, so there is no
   * window where a port reads as approved but has no proxy yet. That window
   * was a real bug: the tunnel would dial the dev server directly, the
   * request would carry the relay's Host, and vite would answer 403 "Blocked
   * request. This host is not allowed" — for the app's own JS, so the page
   * loaded but never hydrated and every button was dead. THE PICK IS THE
   * AUTHORIZATION: a hand-edited cookie naming 5432 finds nothing here and
   * the channel is refused. In memory only, on purpose: an app restart
   * closes the door rather than quietly leaving it open.
   */
  private previewProxies = new Map<number, PreviewProxy>();

  /** Approve one port (validated by the caller against a live discovery).
   *  Builds the Host-rewriting proxy FIRST and only then records approval, so
   *  an open frame never finds the port approved with no proxy behind it. */
  async allowPreview(port: number, host: string): Promise<void> {
    const existing = this.previewProxies.get(port);
    if (existing) {
      if (existing.host === host) return; // already proxying that dev server
      existing.close();
      this.previewProxies.delete(port); // host moved (e.g. 127.0.0.1 → ::1)
    }
    // If this throws the port stays unapproved — better a clean refusal than
    // a direct dial that vite answers with an inscrutable 403.
    const proxy = await startPreviewProxy({ port, host });
    this.previewProxies.set(port, proxy);
  }
  previewTarget(port: number): string | undefined {
    return this.previewProxies.get(port)?.host;
  }
  clearPreview(): void {
    for (const p of this.previewProxies.values()) p.close();
    this.previewProxies.clear();
  }

  private mcpChannel(ws: WebSocket, ch: string): Pick<Socket, 'write' | 'end' | 'destroy'> {
    const done = (): void => {
      if (this.channels.delete(ch) && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ ch, t: 'close' }));
    };
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ ch, t: 'data', d: Buffer.from(chunk).toString('base64') }));
        cb();
      },
      final(cb) {
        done();
        cb();
      },
      destroy(err, cb) {
        done();
        cb(err);
      },
    });
    // http.Server treats it as a socket
    Object.assign(stream, {
      setTimeout: () => stream,
      setNoDelay: () => stream,
      setKeepAlive: () => stream,
      remoteAddress: 'relay',
    });
    (this.mcpHandler as (s: Duplex) => void)(stream);
    return {
      write: ((buf: Buffer) => stream.push(buf)) as Socket['write'],
      end: (() => {
        stream.push(null);
        return stream;
      }) as unknown as Socket['end'],
      destroy: (() => stream.destroy()) as unknown as Socket['destroy'],
    };
  }

  /** Re-read config and reconcile: start, restart (url/token changed) or stop. */
  apply(): void {
    const { remote, lan } = loadConfig();
    const want =
      remote.enabled && !!remote.url && !!remote.deviceId && !!remote.token && lan.enabled;
    const key = `${remote.url}|${remote.deviceId}|${remote.token}|${remote.tlsFingerprint}|${lan.port}`;
    if (!want) {
      this.stop(
        remote.enabled && !lan.enabled
          ? 'LAN access must be enabled (the relay tunnels into it)'
          : '',
      );
      return;
    }
    if (!this.stopped && this.currentKey === key) return;
    this.stop('');
    this.currentKey = key;
    this.stopped = false;
    this.attempt = 0;
    this.dial();
  }
  private currentKey = '';

  private stop(reason: string): void {
    this.stopped = true;
    this.lastError = reason;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.teardown();
  }

  private lanToken = '';

  private teardown(): void {
    clearTunnelToken();
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = undefined;
    for (const s of this.channels.values()) s.destroy();
    this.channels.clear();
    const ws = this.ws;
    this.ws = undefined;
    this.connected = false;
    try {
      ws?.terminate();
    } catch {
      /* already gone */
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 30_000;
    this.attempt++;
    this.timer = setTimeout(() => this.dial(), delay);
    this.timer.unref?.();
  }

  private dial(): void {
    if (this.stopped) return;
    const { remote, lan } = loadConfig();
    const base = remote.url.replace(/\/+$/, '');
    const url = base.endsWith('/agent') ? base : `${base}/agent`;
    const fp = normalizeFingerprint(remote.tlsFingerprint);
    const ws = new WebSocket(url, {
      handshakeTimeout: 10_000,
      // self-signed relay: Node's own verification is off and the cert is
      // pinned by sha256 fingerprint in the 'upgrade' hook below (with
      // rejectUnauthorized:false Node IGNORES checkServerIdentity errors, so
      // the pin must be enforced by hand). No pin → system CAs as usual.
      ...(fp ? { rejectUnauthorized: false } : {}),
    });
    this.ws = ws;
    if (fp) {
      ws.on('upgrade', (res) => {
        const cert = (res.socket as TLSSocket).getPeerCertificate();
        const got = (cert?.fingerprint256 ?? '').replace(/:/g, '').toUpperCase();
        if (got !== fp) {
          // full values: a truncated fingerprint can't be compared or pasted
          this.lastError =
            `relay certificate fingerprint mismatch — relay presented ${got}, ` +
            `config pins ${fp}. Re-check with \`fingerprint\` on the relay box.`;
          ws.terminate();
        }
      });
    }
    ws.on('open', () => {
      // LAN pass (SSO): handed to relay clients that signed in and picked
      // this device, so they skip the LAN password page. DERIVED from the
      // device token instead of random-per-connection: it must survive
      // tunnel reconnects and app restarts, or every phone's cookie dies
      // whenever the desktop blips (lock screen → "please log in again").
      const lanToken = createHash('sha256').update(`${remote.token}:lanpass`).digest('base64url');
      this.lanToken = lanToken;
      ws.send(
        JSON.stringify({
          t: 'auth',
          device: remote.deviceId,
          token: remote.token,
          lanToken,
          caps: this.mcpHandler ? ['mcp'] : [],
        }),
      );
    });
    ws.on('message', (raw) => {
      let m: {
        t?: string;
        ch?: string;
        d?: string;
        clientPort?: number;
        port?: number;
        target?: string;
      };
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      // ANY frame proves the tunnel is still alive
      this.lastSeen = Date.now();
      if (m.t === 'ok') {
        setTunnelToken(this.lanToken);
        this.connected = true;
        this.attempt = 0;
        this.lastError = '';
        this.clientPort = m.clientPort;
        this.since = new Date().toISOString();
        this.pinger = setInterval(() => {
          if (this.ws !== ws) return;
          // watchdog: pings were being sent and pongs thrown away, so a
          // silently-dead connection stayed "connected" forever
          if (Date.now() - this.lastSeen > DEAD_MS) {
            this.lastError = 'relay stopped answering — reconnecting';
            this.teardown();
            this.attempt = 0; // a network change deserves a fast first retry
            this.schedule();
            return;
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }));
        }, PING_MS);
        this.pinger.unref?.();
        return;
      }
      if (m.t === 'pong' || !m.ch) return;
      const ch = m.ch;
      if (m.t === 'open' && m.target === 'mcp') {
        // Served in-process by the sidecar's external MCP (its own consent per
        // machine) — no port is dialed, so the relay still names no target.
        if (!this.mcpHandler) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ch, t: 'close' }));
          return;
        }
        this.channels.set(ch, this.mcpChannel(ws, ch));
        return;
      }
      if (m.t === 'open') {
        // No port on the frame = the Ateam UI itself, as it has always been.
        // A port means preview, and it must be one the user approved — the
        // relay is not trusted to name a target, only to relay the request.
        const dial = previewDial({
          framePort: m.port,
          lanPort: lan.port,
          approved: this.previewProxies,
        });
        if (dial.kind === 'refuse') {
          // close rather than hang: the relay turns a closed channel into an
          // error page instead of leaving the phone on a spinner
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ch, t: 'close' }));
          return;
        }
        // Preview always goes through its loopback proxy (Host rewrite, see
        // preview-proxy.ts) — never straight to the dev server, whose Host
        // check would 403 the relay's Host. The proxy exists whenever the
        // port is approved (allowPreview builds it first); if somehow it does
        // not, refuse rather than direct-dial into that 403.
        const proxy = dial.kind === 'preview' ? this.previewProxies.get(dial.port) : undefined;
        if (dial.kind === 'preview' && !proxy) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ch, t: 'close' }));
          return;
        }
        const sock = proxy
          ? netConnect(proxy.port, '127.0.0.1')
          : netConnect(lan.port, '127.0.0.1');
        this.channels.set(ch, sock);
        sock.on('data', (buf: Buffer) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ ch, t: 'data', d: buf.toString('base64') }));
        });
        const done = (): void => {
          if (this.channels.delete(ch) && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ ch, t: 'close' }));
        };
        sock.on('end', done);
        sock.on('close', done);
        sock.on('error', done);
        return;
      }
      const sock = this.channels.get(ch);
      if (!sock) return;
      if (m.t === 'data' && m.d) sock.write(Buffer.from(m.d, 'base64'));
      else if (m.t === 'close') {
        this.channels.delete(ch);
        sock.end();
      }
    });
    ws.on('error', (e) => {
      this.lastError = e.message;
    });
    ws.on('close', (code, reason) => {
      const r = reason.toString();
      if (code === RELAY_CLOSE.badToken) this.lastError = 'relay rejected the device id / token';
      else if (r && !this.lastError) this.lastError = r;
      if (this.ws !== ws) return;
      const action = closeAction(code);
      if (action === 'stand-down') {
        this.stop('another copy of Ateam is connected as this machine — this one stood down');
        return;
      }
      this.teardown();
      // parked by the relay for reconnecting too fast: come back at the
      // slowest backoff instead of immediately, or we re-earn the park
      if (action === 'slow-retry') this.attempt = BACKOFF_MS.length;
      this.schedule();
    });
  }

  status(): RemoteStatus {
    const { remote } = loadConfig();
    return {
      enabled: remote.enabled,
      connected: this.connected,
      url: remote.url,
      deviceId: remote.deviceId,
      ...(this.clientPort ? { clientPort: this.clientPort } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.since && this.connected ? { since: this.since } : {}),
    };
  }

  shutdown(): void {
    this.stop('');
    this.clearPreview();
  }
}
