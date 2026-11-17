import type { ExternalMcpStatus } from '@ateam/contract';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { notify } from './notify';
import type { Rpc } from './rpc';
import './externalMcp.css';

function useAccess(rpc: Rpc) {
  const [status, setStatus] = useState<ExternalMcpStatus>();
  const [error, setError] = useState('');
  const refresh = useCallback(() => {
    void rpc
      .request('externalMcp.status', {})
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, [rpc]);
  useEffect(() => {
    refresh();
    const off = rpc.on('externalMcp.changed', refresh);
    const timer = setInterval(refresh, 3000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [rpc, refresh]);
  return { status, error, setError, refresh };
}

export function McpPane({ rpc }: { rpc: Rpc }): JSX.Element {
  const { status, error, setError, refresh } = useAccess(rpc);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const register = async (client: 'chatgpt' | 'claude-desktop' | 'cursor-desktop') => {
    setBusy(true);
    setError('');
    try {
      const r = await rpc.request('externalMcp.register', { client });
      setNote(
        client === 'chatgpt'
          ? r.plugin?.installed
            ? 'Plugin installed and enabled. Ordinary Chat use is not yet verified. Open a new ordinary Chat, select Ateam, and request list_sessions.'
            : `MCP configured; plugin setup is incomplete. ${r.plugin?.error ?? 'Check the plugin stages below.'}`
          : client === 'cursor-desktop'
            ? r.restartRequired
              ? 'Configuration written. Fully quit and reopen Cursor, then approve project access in Ateam. Configuration does not mean Cursor has loaded the server.'
              : 'Configuration is up to date. Reload Cursor if Ateam is missing, then approve project access in Ateam.'
            : r.restartRequired
              ? 'Configuration written. Fully quit and reopen Claude Desktop, then approve access here.'
              : 'Configuration is up to date. Reload the client if Ateam is missing, then approve access here.',
      );
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="section">
      <div className="settings-eyebrow">Local connections</div>
      <h3 className="section-title">MCP</h3>
      <p>
        Connect ChatGPT, Claude Desktop, or Cursor Desktop to Ateam. Configuration does not mean the
        client has loaded the server; each client still needs approval in Ateam before it can access
        selected projects.
      </p>
      <p className="mono">{status?.endpoint || 'Local service unavailable'}</p>
      <div className="mcp-actions">
        <button
          type="button"
          disabled={busy || !status?.endpoint}
          onClick={() => void register('chatgpt')}
        >
          Register ChatGPT
        </button>
        <button
          type="button"
          disabled={busy || !status?.endpoint}
          onClick={() => void register('claude-desktop')}
        >
          Register Claude Desktop
        </button>
        <button
          type="button"
          disabled={busy || !status?.endpoint}
          onClick={() => void register('cursor-desktop')}
        >
          Register Cursor Desktop
        </button>
      </div>
      {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
      {note && <output>{note}</output>}
      {status?.chatgptPlugin && (
        <div className="mcp-client">
          <strong>ChatGPT plugin setup</strong>
          <div>Package: {status.chatgptPlugin.packageWritten ? 'written' : 'missing'}</div>
          <div>
            Marketplace:{' '}
            {status.chatgptPlugin.marketplaceRegistered ? 'registered' : 'not registered'}
          </div>
          <div>Discovery: {status.chatgptPlugin.discovered ? 'confirmed' : 'not confirmed'}</div>
          <div>
            Installation:{' '}
            {status.chatgptPlugin.installed ? 'installed and enabled' : 'not confirmed'}
          </div>
          <div>Ordinary Chat: not verified</div>
          <p>
            In a new ordinary Chat, select Ateam and ask it to list sessions. Approve project access
            in Ateam when prompted.
          </p>
          {status.chatgptPlugin.error && <p role="alert">{status.chatgptPlugin.error}</p>}
        </div>
      )}
      {status?.clients.map((c) => (
        <div className="mcp-client" key={c.id}>
          <strong>{c.name}</strong>
          <span>
            {c.connected
              ? c.status
              : c.status === 'registered'
                ? 'Configured · reload client'
                : `${c.status} · client offline`}
          </span>
          <div>{c.projects.join(', ') || 'No project access'}</div>
          {Object.entries(c.capabilities ?? {})
            .filter(([, caps]) => caps.length)
            .map(([root, caps]) => (
              <div key={root} className="mcp-caps">
                {root}: {caps.map((cap) => CAPABILITY_LABEL[cap] ?? cap).join(', ')}
              </div>
            ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void rpc
                .request(c.status === 'approved' ? 'externalMcp.revoke' : 'externalMcp.retry', {
                  id: c.id,
                })
                .then(refresh)
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false));
            }}
          >
            {c.status === 'approved' ? 'Revoke access' : 'Allow a new request'}
          </button>
        </div>
      ))}
      <div className="mcp-client">
        <strong>Web connectors (ChatGPT Chat, Claude web, Gemini web)</strong>
        {status?.publicMcp ? (
          <>
            <div className="mono">{status.publicMcp.url}</div>
            <div>
              Tunnel:{' '}
              {status.publicMcp.tunnel === 'running'
                ? 'running'
                : status.publicMcp.tunnel === 'starting'
                  ? 'starting'
                  : status.publicMcp.tunnel === 'missing-cloudflared'
                    ? 'cloudflared not installed'
                    : 'not connected'}
            </div>
            {status.publicMcp.error && status.publicMcp.tunnel !== 'running' && (
              <p role="alert">{status.publicMcp.error}</p>
            )}
            <p>
              Add a custom connector with this URL and OAuth authentication. Each sign-in asks for
              approval here with a matching code.
            </p>
          </>
        ) : (
          <p>Not configured. Run scripts/setup-public-mcp.sh, then restart Ateam.</p>
        )}
      </div>
    </section>
  );
}

/** Mounted at app level, so requests appear even when Settings is closed. */
export function McpApproval({ rpc }: { rpc: Rpc }): JSX.Element | null {
  const { status, error, setError, refresh } = useAccess(rpc);
  const request = status?.pending[0];
  const requestId = request?.id;
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (requestId) {
      setSelected([]);
      setError('');
    }
  }, [requestId, setError]);
  const decide = async (allow: boolean) => {
    if (!request) return;
    setBusy(true);
    try {
      await rpc.request('externalMcp.decide', {
        id: request.id,
        allow,
        projects: allow ? selected : [],
      });
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const requestName = request?.name;
  useEffect(() => {
    if (!requestId) return;
    notify(
      'Ateam access request',
      `${requestName ?? 'A client'} wants to connect. Open Ateam to review.`,
    );
    if (window.isTauri)
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().setFocus())
        .catch(() => {});
  }, [requestId, requestName]);
  useEffect(() => {
    if (!requestId) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.getElementById('mcp-approval') as HTMLDialogElement | null;
    dialog?.showModal();
    dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, [requestId]);
  if (!request) return <McpAccessRequest rpc={rpc} status={status} refresh={refresh} />;
  return createPortal(
    <dialog
      id="mcp-approval"
      className="mcp-approval"
      aria-labelledby="mcp-approval-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) void decide(false);
      }}
    >
      <h2 id="mcp-approval-title">Allow {request.name} to connect?</h2>
      {request.pairingCode ? (
        <>
          <p>
            A web connector is signing in over the internet. Allow it only if the sign-in page you
            opened shows this code:
          </p>
          <p className="mcp-pairing-code mono">{request.pairingCode}</p>
          <p>
            It can list sessions, send requests to your CLI, and read replies in the projects you
            select. Existing CLI permissions still apply.
          </p>
        </>
      ) : (
        <p>
          This local client can list sessions, send requests to your CLI, and read replies in the
          projects you select. Existing CLI permissions still apply.
        </p>
      )}
      <p>Choose projects to share:</p>
      <div className="mcp-projects">
        {status?.projects.map((root) => (
          <label key={root}>
            <input
              type="checkbox"
              checked={selected.includes(root)}
              onChange={(e) =>
                setSelected((prev) =>
                  e.target.checked ? [...prev, root] : prev.filter((p) => p !== root),
                )
              }
            />{' '}
            <span>{root}</span>
          </label>
        ))}
      </div>
      {!status?.projects.length && <p>Open a project session in Ateam before granting access.</p>}
      <p>Approval expires if unanswered for 5 minutes. You can revoke access in Settings → MCP.</p>
      {error && <p role="alert">{error}</p>}
      <div className="mcp-actions">
        <button type="button" disabled={busy} onClick={() => void decide(false)}>
          Deny
        </button>
        <button type="button" disabled={busy || !selected.length} onClick={() => void decide(true)}>
          Allow selected projects
        </button>
      </div>
    </dialog>,
    document.body,
  );
}

const CAPABILITY_LABEL: Record<string, string> = {
  execute: 'run commands',
  git_commit: 'git commit',
  git_push: 'git push',
  create_session: 'create sessions',
};

/** A client asks for a project folder and actions; approval lasts until revoked. */
function McpAccessRequest({
  rpc,
  status,
  refresh,
}: {
  rpc: Rpc;
  status: ExternalMcpStatus | undefined;
  refresh: () => void;
}): JSX.Element | null {
  const request = status?.requests?.[0];
  const requestId = request?.id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!requestId) return;
    setError('');
    notify('Ateam access request', `${request?.client ?? 'A client'} asks for ${request?.root ?? 'a project'}.`);
    if (window.isTauri)
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().setFocus())
        .catch(() => {});
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.getElementById('mcp-access-request') as HTMLDialogElement | null;
    dialog?.showModal();
    dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, [requestId, request?.client, request?.root]);
  if (!request) return null;
  const decide = async (allow: boolean) => {
    setBusy(true);
    try {
      await rpc.request('externalMcp.decideRequest', { id: request.id, allow });
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const actions = request.capabilities.map((c) => CAPABILITY_LABEL[c] ?? c);
  return createPortal(
    <dialog
      id="mcp-access-request"
      className="mcp-approval"
      aria-labelledby="mcp-access-request-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) void decide(false);
      }}
    >
      <h2 id="mcp-access-request-title">{request.client} asks for project access</h2>
      <p className="mono">{request.root}</p>
      <p>Reason given: {request.reason || 'none'}</p>
      <p>
        It will be able to read this project and message its sessions
        {actions.length ? (
          <>
            , and to <strong>{actions.join(', ')}</strong> without asking again
          </>
        ) : null}
        . Sensitive files stay hidden. You can revoke access in Settings → MCP.
      </p>
      {actions.length > 0 && (
        <p role="alert">
          Allow these actions only for a client you trust: anyone holding this connection could
          run them on this computer.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="mcp-actions">
        <button type="button" disabled={busy} onClick={() => void decide(false)}>
          Deny
        </button>
        <button type="button" disabled={busy} onClick={() => void decide(true)}>
          Allow
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
