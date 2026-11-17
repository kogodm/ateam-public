import qrcode from 'qrcode-generator';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from './mobile';
import { type Anchor, popoverAnchor } from './popoverAnchor';
import type { Rpc } from './rpc';

type LanStatus = {
  running: boolean;
  enabled: boolean;
  passwordSet: boolean;
  port: number;
  urls: string[];
  error?: string;
};
type McpStatus = {
  endpoint: string;
  error?: string;
  staleProjects?: string[];
  clients: { id: string; name: string; status: string; connected: boolean }[];
  pending: { id: string }[];
  publicMcp?: { tunnel: string; error?: string };
};
type RemoteStatus = {
  enabled: boolean;
  connected: boolean;
  clientPort?: number;
  url: string;
  deviceId: string;
  lastError?: string;
};

/** https://<relay host>:<client port> — the address phones open */
function remotePublicUrl(r: RemoteStatus | null): string {
  if (!r?.connected || !r.clientPort || !r.url) return '';
  const host = r.url.replace(/^wss?:\/\//, '').replace(/[:/].*$/, '');
  return host ? `https://${host}:${r.clientPort}` : '';
}

const isTauri = typeof window !== 'undefined' && Boolean((window as { isTauri?: boolean }).isTauri);
function copyText(text: string): void {
  if (isTauri) {
    void import('@tauri-apps/plugin-clipboard-manager')
      .then((m) => m.writeText(text))
      .catch(() => {});
    return;
  }
  void navigator.clipboard?.writeText(text).catch(() => {});
}

/** QR as an inline SVG path (one rect-run per dark module row segment) —
 *  crisp at any size, themed via currentColor, no <img>/data URL. */
function qrSvg(text: string, size: number): JSX.Element {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  const total = n + quiet * 2;
  const parts: string[] = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++;
        continue;
      }
      let run = 1;
      while (c + run < n && qr.isDark(r, c + run)) run++;
      parts.push(`M${c + quiet} ${r + quiet}h${run}v1h-${run}z`);
      c += run;
    }
  }
  return (
    <svg
      className="lan-qr"
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-label={text}
    >
      <title>{text}</title>
      <rect width={total} height={total} fill="#fff" rx="1.2" />
      <path d={parts.join('')} fill="#0b0e14" />
    </svg>
  );
}

/** Wifi-style LAN icon; `on` paints the dot with the status colour.
 *  Stroke 2.0 against the bar's 1.8: curved hairlines anti-alias worse than
 *  the straight strokes beside them, so a hair more keeps the arcs solid
 *  without making this one glyph look bolder than the row. (The old 2.4 was
 *  compensating for a glyph that was really being drawn at 6px — see the
 *  `.bar button.lan-trigger` note in styles.css. Size comes from the bar.) */
export function LanIcon({ on }: { on: boolean }): JSX.Element {
  return (
    <svg
      className={`lan-icon${on ? ' on' : ''}`}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path className="lan-arc lan-arc-3" d="M3 9.5a13.5 13.5 0 0 1 18 0" />
      <path className="lan-arc lan-arc-2" d="M6.2 12.8a9 9 0 0 1 11.6 0" />
      <path className="lan-arc lan-arc-1" d="M9.4 16a4.5 4.5 0 0 1 5.2 0" />
      <circle className="lan-dot" cx="12" cy="19.2" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** One card of the network popover: a status pill, a QR + address with Copy
 *  when reachable, otherwise a hint and a jump to Settings. */
function NetCard({
  title,
  pill,
  tone,
  url,
  urls,
  onPick,
  hint,
  foot,
  copied,
  onCopy,
  onSettings,
}: {
  title: string;
  pill: string;
  tone: 'on' | 'warn' | 'off';
  url: string;
  urls?: string[];
  onPick?: (u: string) => void;
  hint: string;
  foot: string;
  copied: string;
  onCopy: (t: string) => void;
  onSettings: () => void;
}): JSX.Element {
  const qr = useMemo(() => (url ? qrSvg(url, 150) : null), [url]);
  const host = url.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  const port = url.match(/:(\d+)$/)?.[1] ?? '';
  return (
    <div className={`lan-card ${tone}`}>
      <div className="lan-pop-head">
        <span className="lan-pop-title">{title}</span>
        <span className={`lan-pill${tone === 'on' ? ' on' : tone === 'warn' ? ' warn' : ''}`}>
          <span className="lan-pill-dot" />
          {pill}
        </span>
      </div>
      {url ? (
        <>
          <div className="lan-qr-wrap">{qr}</div>
          <div className="lan-url-row primary">
            <span className="lan-url-meta">
              <span className="lan-url-ip">{host}</span>
              {port && <span className="lan-url-port">:{port}</span>}
            </span>
            <code className="lan-url">{url}</code>
            <button
              type="button"
              className={`lan-copy${copied === url ? ' done' : ''}`}
              onClick={() => onCopy(url)}
              title="Copy address"
            >
              {copied === url ? 'Copied' : 'Copy'}
            </button>
          </div>
          {urls && urls.length > 1 && (
            <div className="lan-others">
              <div className="lan-others-title">Other interfaces</div>
              {urls.map((u) =>
                u === url ? null : (
                  <div key={u} className="lan-url-row">
                    <button
                      type="button"
                      className="lan-url-pick"
                      onClick={() => onPick?.(u)}
                      title="Show this address's QR"
                    >
                      <code className="lan-url">{u}</code>
                    </button>
                    <button
                      type="button"
                      className={`lan-copy${copied === u ? ' done' : ''}`}
                      onClick={() => onCopy(u)}
                      title="Copy address"
                    >
                      {copied === u ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                ),
              )}
            </div>
          )}
        </>
      ) : (
        <p className="lan-pop-body">{hint}</p>
      )}
      <div className="lan-foot">
        <span className="muted">{foot}</span>
        <button type="button" className="lan-link" onClick={onSettings}>
          Settings ↗
        </button>
      </div>
    </div>
  );
}

/** Full-width status card for the external MCP server: is the local endpoint
 *  listening, which clients are connected, and what is silently wrong. */
function McpCard({
  mcp,
  onSettings,
}: { mcp: McpStatus | null; onSettings: () => void }): JSX.Element {
  const running = !!mcp?.endpoint;
  const failed = !!mcp && !running && !!mcp.error;
  const approved = mcp?.clients.filter((c) => c.status === 'approved') ?? [];
  const live = approved.filter((c) => c.connected);
  const stale = mcp?.staleProjects ?? [];
  const tone: 'on' | 'warn' | 'off' =
    running && !stale.length ? 'on' : failed || stale.length ? 'warn' : 'off';
  const port = mcp?.endpoint.match(/:(\d+)\//)?.[1];
  const pill = running
    ? `on${port ? ` · port ${port}` : ''}`
    : failed
      ? 'failed'
      : mcp
        ? 'off'
        : '...';
  return (
    <div className={`lan-card mcp-card ${tone}`}>
      <div className="lan-pop-head">
        <span className="lan-pop-title">MCP</span>
        <span className={`lan-pill${tone === 'on' ? ' on' : tone === 'warn' ? ' warn' : ''}`}>
          <span className="lan-pill-dot" />
          {pill}
        </span>
      </div>
      {mcp?.error && !running && <p className="mcp-line err">{mcp.error}</p>}
      {running && (
        <p className="mcp-line">
          {approved.length
            ? `${live.length} of ${approved.length} approved client${approved.length === 1 ? '' : 's'} connected${live.length ? `: ${live.map((c) => c.name).join(', ')}` : ''}`
            : 'No approved clients yet.'}
          {mcp.pending.length ? ` · ${mcp.pending.length} waiting for approval` : ''}
        </p>
      )}
      {mcp?.publicMcp && (
        <p className={`mcp-line${mcp.publicMcp.tunnel === 'error' ? ' err' : ''}`}>
          Public connector tunnel: {mcp.publicMcp.tunnel}
          {mcp.publicMcp.error ? ` — ${mcp.publicMcp.error}` : ''}
        </p>
      )}
      {stale.length > 0 && (
        <p className="mcp-line err">
          {stale.length} granted project{stale.length === 1 ? '' : 's'} no longer exist
          {stale.length === 1 ? 's' : ''} and {stale.length === 1 ? 'is' : 'are'} skipped:{' '}
          {stale.map((p) => p.split('/').pop()).join(', ')}
        </p>
      )}
      <div className="lan-foot">
        <span className="muted">ChatGPT / Claude connectors</span>
        <button type="button" className="lan-link" onClick={onSettings}>
          Settings ↗
        </button>
      </div>
    </div>
  );
}

/** Top-bar network button + popover: two cards — LAN (http://ip:port on the
 *  local network) and Remote (https://relay:port through the tunnel) — each
 *  with live status, QR and Copy, so a phone joins with one scan. */
interface DevServer {
  port: number;
  process: string;
  host: string;
  title?: string;
}

export function LanButton({
  rpc,
  relayMode,
  onOpenSettings,
}: { rpc: Rpc | null; relayMode?: boolean; onOpenSettings: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  /* The panel does not live in the bar. The bar is a scroll container
     (overflow-x:auto) and, on the desktop, a backdrop-filter surface — the
     first clips a panel hanging below it, the second makes the bar the
     containing block for position:fixed descendants, which drags a "fixed"
     panel back inside the thing that clips it. This has been fixed twice by
     patching whichever of the two was biting (`.app[data-mobile]` rules), and
     it has now come back a third time, so: the panel is portalled to <body>,
     out of reach of anything the bar can do, and told where to sit. The
     symptom to recognise is exact — the button toggles, nothing appears. */
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const isMobile = useIsMobile();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const place = useCallback(() => {
    const el = btnRef.current;
    if (el) setAnchor(popoverAnchor(el.getBoundingClientRect(), window.innerWidth));
  }, []);
  /* Re-measure while it is open: a rotation, the soft keyboard, or the bar
     scrolling sideways all move the trigger out from under the panel. */
  useEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('orientationchange', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('orientationchange', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [open, place]);
  const [st, setSt] = useState<LanStatus | null>(null);
  const [rm, setRm] = useState<RemoteStatus | null>(null);
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [pick, setPick] = useState(0);
  const [copied, setCopied] = useState('');
  /** local web servers this machine is running — discovered, never typed in:
   *  the person looking is usually on a phone and an agent started the thing */
  const [servers, setServers] = useState<DevServer[] | null>(null);
  const [previewBusy, setPreviewBusy] = useState('');
  /** The address the last "open" resolved to, kept as a real link under the
   *  list. A new window can only be opened synchronously inside the tap;
   *  when the browser refused ours (Safari after an await, home-screen PWAs
   *  more often still) the person taps this instead — an <a target=_blank>
   *  inside its own tap is never blocked. */
  const [previewLink, setPreviewLink] = useState<{ port: number; url: string } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);

  const load = useCallback(() => {
    if (!rpc) return;
    void rpc
      .request('lan.status', {})
      .then((s) => setSt(s))
      .catch(() => {});
    void rpc
      .request('remote.status', {})
      .then((r) => setRm(r))
      .catch(() => {});
    void rpc
      .request('externalMcp.status', {})
      .then((m) => setMcp(m))
      .catch(() => {});
  }, [rpc]);

  // status on mount + a slow poll so the button's dot is live, faster while open
  useEffect(() => {
    load();
    const t = setInterval(load, open ? 3000 : 20_000);
    return () => clearInterval(t);
  }, [load, open]);

  // Discovery only when the panel opens: every candidate port costs an HTTP
  // probe, which is nothing once and rude on a timer.
  useEffect(() => {
    if (!open || !rpc) return;
    setServers(null);
    void rpc
      .request('preview.servers', {})
      .then((r) => setServers(r.servers))
      .catch(() => setServers([]));
  }, [open, rpc]);

  /** Approve a port and open it. Through the relay the tunnel carries it; on
   *  the LAN there is nothing to tunnel — the phone can reach the port itself,
   *  so we just hand over the direct address.
   *
   *  The window is opened FIRST, synchronously in the tap: Safari treats a
   *  window.open that comes after an await as a popup and drops it, so
   *  "open" used to do nothing on the phone. On the LAN the address is known
   *  up front; through the relay a blank window is opened now and pointed at
   *  the tunnel URL once the relay hands it over. Either way the address is
   *  also left as a tappable link under the list (previewLink). */
  const openPreview = useCallback(
    async (s: DevServer) => {
      if (!rpc) return;
      const base = (st?.urls?.[0] ?? '').replace(/:\d+$/, '');
      const direct = relayMode ? '' : base ? `${base}:${s.port}` : '';
      const win = window.open(direct || 'about:blank', '_blank');
      if (direct) setPreviewLink({ port: s.port, url: direct });
      setPreviewBusy(`opening :${s.port}…`);
      try {
        const allowed = await rpc.request('preview.allow', { port: s.port });
        if (!allowed.ok) throw new Error(allowed.err ?? 'that port is not serving a page');
        if (relayMode) {
          const r = await fetch('/relay/api/preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ port: s.port }),
          });
          const body = (await r.json()) as { url?: string; err?: string };
          if (!body.url) throw new Error(body.err ?? 'this relay has no preview port');
          setPreviewLink({ port: s.port, url: body.url });
          if (win) win.location.href = body.url;
        } else if (!direct) {
          throw new Error('no LAN address to reach it on');
        }
        setPreviewBusy(win ? '' : 'popup blocked — tap the link below');
      } catch (e) {
        win?.close();
        setPreviewBusy(e instanceof Error ? e.message : String(e));
        setTimeout(() => setPreviewBusy(''), 4000);
      }
    },
    [rpc, relayMode, st],
  );

  /** Stop sharing: the relay forgets which port this browser asked for, so no
   *  channel can name one again. */
  const stopPreview = useCallback(async () => {
    await fetch('/relay/api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => {});
    setPreviewBusy('stopped');
    setTimeout(() => setPreviewBusy(''), 2000);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      // the panel is a child of <body> now, so "inside" is two elements
      if (rootRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const lanRunning = !!st?.running && (st?.urls.length ?? 0) > 0;
  const urls = st?.urls ?? [];
  const lanUrl = urls[Math.min(pick, Math.max(0, urls.length - 1))] ?? '';
  const remoteUrl = remotePublicUrl(rm);
  const anyOn = lanRunning || !!remoteUrl;

  const copy = (text: string): void => {
    copyText(text);
    setCopied(text);
    setTimeout(() => setCopied(''), 1200);
  };
  const goSettings = (): void => {
    setOpen(false);
    onOpenSettings();
  };

  return (
    <span ref={rootRef} className="lan">
      <button
        type="button"
        ref={btnRef}
        className={`bar-icon lan-trigger${anyOn ? ' on' : ''}${open ? ' open' : ''}`}
        onClick={(e) => {
          setAnchor(popoverAnchor(e.currentTarget.getBoundingClientRect(), window.innerWidth));
          setOpen((v) => !v);
        }}
        title={
          anyOn
            ? `${lanRunning ? 'LAN on' : 'LAN off'} · ${remoteUrl ? 'Remote connected' : 'Remote off'}`
            : 'LAN / Remote access off — click for details'
        }
        aria-haspopup="true"
        aria-expanded={open}
      >
        <LanIcon on={anyOn} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="lan-pop two"
            data-mobile={isMobile ? '1' : undefined}
            aria-label="Network access"
            style={
              {
                '--lan-pop-top': `${anchor?.top ?? 56}px`,
                '--lan-pop-right': `${anchor?.right ?? 12}px`,
              } as React.CSSProperties
            }
          >
            <NetCard
              title="LAN"
              pill={
                lanRunning ? `on · port ${st?.port}` : st?.enabled ? 'enabled · no address' : 'off'
              }
              tone={lanRunning ? 'on' : st?.enabled ? 'warn' : 'off'}
              url={lanRunning ? lanUrl : ''}
              urls={urls}
              onPick={(u) => setPick(urls.indexOf(u))}
              hint={
                st?.enabled
                  ? (st.error ??
                    'Enabled, but no LAN IPv4 address was found — is this machine on a network?')
                  : st?.passwordSet
                    ? 'Turn on LAN access in Settings → Remote to open this Ateam to devices on your network.'
                    : 'Set a password and turn on LAN access in Settings → Remote to open this Ateam to devices on your network.'
              }
              foot="Same network · password required"
              copied={copied}
              onCopy={copy}
              onSettings={goSettings}
            />
            <NetCard
              title="Remote"
              pill={remoteUrl ? 'connected' : rm?.enabled ? 'connecting…' : 'off'}
              tone={remoteUrl ? 'on' : rm?.enabled ? 'warn' : 'off'}
              url={remoteUrl}
              hint={
                rm?.enabled
                  ? `Tunnel not up yet${rm.lastError ? ` — ${rm.lastError}` : ''}. It retries by itself.`
                  : 'Connect this Ateam to a relay you host (Settings → Remote → Remote access) to reach it from anywhere.'
              }
              foot="Anywhere · relay + password"
              copied={copied}
              onCopy={copy}
              onSettings={goSettings}
            />
            {/* The app-wide MCP server (ChatGPT / Claude connectors): one line of
              truth for "can an outside client reach this machine right now". */}
            <McpCard mcp={mcp} onSettings={goSettings} />
            {/* Review what you are BUILDING, not just Ateam itself. The list is
              discovered, because the person looking is usually on a phone and
              an agent started the server — nobody knows the port. */}
            <div className="lan-preview">
              <div className="lan-preview-head">
                <span className="lan-preview-title">Preview a local site</span>
                {previewBusy && <span className="lan-preview-note">{previewBusy}</span>}
              </div>
              {servers === null && <div className="lan-preview-empty">looking…</div>}
              {servers?.length === 0 && (
                <div className="lan-preview-empty">
                  No local web server is running. Start one and reopen this.
                </div>
              )}
              {servers?.map((s) => (
                <button
                  type="button"
                  key={s.port}
                  className="lan-preview-row"
                  onClick={() => void openPreview(s)}
                >
                  <span className="lan-preview-port">:{s.port}</span>
                  <span className="lan-preview-name">{s.title || s.process}</span>
                  <span className="lan-preview-go">open ↗</span>
                </button>
              ))}
              {previewLink && (
                <a
                  className="lan-preview-link"
                  href={previewLink.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span className="lan-preview-port">:{previewLink.port}</span>
                  <span className="lan-preview-name">{previewLink.url}</span>
                  <span className="lan-preview-go">open ↗</span>
                </a>
              )}
              {relayMode && !!servers?.length && (
                <button
                  type="button"
                  className="lan-preview-stop"
                  onClick={() => void stopPreview()}
                >
                  Stop sharing
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
