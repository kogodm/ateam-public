import type { Result, SessionNode, TaskDTO } from '@ateam/contract';
import { useCallback, useEffect, useState } from 'react';
import { BrowserPane } from './PanelBrowser';
import { FilesPane } from './PanelFiles';
import { GitPane } from './PanelGit';
import { TasksPane } from './PanelTasks';
import { PanelUsage } from './PanelUsage';
import { PermissionsButton } from './PermissionsButton';
import type { Rpc } from './rpc';

type Tab = 'status' | 'tasks' | 'growth' | 'git' | 'files' | 'browser' | 'tokens';
type Usage = Result<'usage.recent'>;

const fmt = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

export function Panel({
  rpc,
  session,
  onOpenPath,
  tokens,
  tokenThreshold,
  startedAt,
  lastOutputAt,
  projectName,
  onJumpTaskSession,
}: {
  rpc: Rpc;
  session: SessionNode | undefined;
  onOpenPath?: (path: string) => void;
  /** Live token estimate for the focused session (polled by App). */
  tokens?: number;
  /** Auto-handoff threshold (mirrored from Settings). */
  tokenThreshold?: number;
  /** ms timestamp the focused session was first seen. */
  startedAt?: number;
  /** ms timestamp of the last meaningful output chunk for the focused session. */
  lastOutputAt?: number;
  /** project display name (App resolves it from the tree). */
  projectName?: string;
  /** jump to the session that filed a task (App resolves live/resume/gone). */
  onJumpTaskSession?: (t: TaskDTO) => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('status');
  const [metaDir, setMetaDir] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sessUsage, setSessUsage] = useState<Result<'session.usage'> | null>(null);
  // bump to force-remount the git/files/growth panes (they load on mount)
  const [reload, setReload] = useState(0);

  // Depend on stable primitives, NOT the session object — App's 5s tree
  // poll rebuilds it every tick, and an object dep would re-fire this (and
  // remount the git/files panes → visible flicker).
  const humanId = session?.humanId;
  const sessionId = session?.sessionId;
  const load = useCallback(async () => {
    if (tab === 'growth' && humanId) {
      setMetaDir((await rpc.request('human.metaDir', { humanId })).dir);
    } else if (tab === 'tokens') {
      // the REAL story: this session's transcript-billed usage; the app's
      // own flywheel spend is secondary
      if (sessionId) {
        setSessUsage(await rpc.request('session.usage', { sessionId }));
      } else {
        setSessUsage(null);
      }
      setUsage(await rpc.request('usage.recent', { limit: 100 }));
    }
    // git/files/growth panes load themselves on mount; ⟳ remounts them explicitly
  }, [tab, humanId, sessionId, rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    if (tab === 'git' || tab === 'files' || tab === 'growth') setReload((k) => k + 1);
    else void load();
  }, [tab, load]);

  return (
    <aside className="panel">
      <div className="tabs">
        {(['status', 'tasks', 'growth', 'git', 'files', 'browser', 'tokens'] as Tab[]).map((t) => (
          <button type="button" key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <button type="button" className="refresh" onClick={refresh}>
          ⟳
        </button>
      </div>

      {tab === 'tasks' && (
        <div className="panel-body">
          <TasksPane rpc={rpc} session={session} onJumpSession={onJumpTaskSession} />
        </div>
      )}

      {tab === 'status' && (
        <div className="panel-body">
          {!session && <div className="muted">focus a session</div>}
          {session &&
            (() => {
              const thr = tokenThreshold ?? 120_000;
              const tk = tokens ?? 0;
              const pct = Math.min(100, Math.max(0, (tk / thr) * 100));
              const tone = pct < 50 ? 'lo' : pct < 80 ? 'ok' : pct < 95 ? 'warn' : 'danger';
              const ageStr = (ms: number): string => {
                if (ms < 0) return '—';
                const s = Math.floor(ms / 1000);
                if (s < 60) return `${s}s`;
                const m = Math.floor(s / 60);
                if (m < 60) return `${m}m`;
                const h = Math.floor(m / 60);
                if (h < 24) return `${h}h ${m % 60}m`;
                const d = Math.floor(h / 24);
                return `${d}d ${h % 24}h`;
              };
              const now = Date.now();
              return (
                <>
                  <div className="status-section">
                    <div className="status-row">
                      <span>Project</span>
                      <b>{projectName ?? '—'}</b>
                    </div>
                    <div className="status-row">
                      <span>Human</span>
                      <b>{session.humanName}</b>
                      <i>[{session.role}]</i>
                    </div>
                    <div className="status-row">
                      <span>State</span>
                      <span className={`status-pill ${session.state}`}>{session.state}</span>
                    </div>
                    {/* The model is read from the runtime's own transcript, so
                        it is the model actually answering — not what the
                        session was launched with, which a mid-conversation
                        /model would have made a lie. Clicking opens the
                        runtime's OWN picker rather than a list of our own:
                        codex refuses `/model <name>` (it sends it to the model
                        as a prompt and burns a turn), and any list we cached
                        would go stale the week either CLI ships a model. */}
                    <div className="status-row">
                      <span>Model</span>
                      {session.model ? (
                        <button
                          type="button"
                          className="status-model"
                          title="切换模型 — 打开这个会话自己的模型选择器"
                          onClick={() => {
                            void rpc
                              .request('session.input', {
                                sessionId: session.sessionId,
                                data: '/model',
                              })
                              .then(() =>
                                rpc.request('session.input', {
                                  sessionId: session.sessionId,
                                  data: '\r',
                                }),
                              )
                              .catch(() => {});
                          }}
                        >
                          {session.model}
                          <span className="status-model-go">›</span>
                        </button>
                      ) : (
                        <b>—</b>
                      )}
                    </div>
                    <div className="status-row">
                      <span>cwd</span>
                      <span className="mono small ellip">{session.cwd}</span>
                    </div>
                    {session.providerId === 'codex' && (
                      <div className="status-row">
                        <span>Access</span>
                        <PermissionsButton
                          rpc={rpc}
                          sessionId={session.sessionId}
                          providerId="codex"
                          className="status-model"
                        />
                      </div>
                    )}
                  </div>

                  <div className="status-section">
                    <div className="status-section-title">Context usage</div>
                    <div className={`status-bar ${tone}`}>
                      <span style={{ width: `${pct}%` }} />
                    </div>
                    <div className="muted small">
                      {tk.toLocaleString()} / {thr.toLocaleString()} tokens · {pct.toFixed(1)}%
                    </div>
                    <div className="muted small">
                      Threshold triggers auto-handoff. Adjust in Settings → Auto-handoff.
                    </div>
                  </div>

                  <div className="status-section">
                    <div className="status-section-title">Activity</div>
                    <div className="status-row">
                      <span>Started</span>
                      <span>{startedAt ? ageStr(now - startedAt) : '—'} ago</span>
                    </div>
                    <div className="status-row">
                      <span>Last message</span>
                      <span>{lastOutputAt ? `${ageStr(now - lastOutputAt)} ago` : '—'}</span>
                    </div>
                  </div>

                  <div className="status-section">
                    <div className="status-section-title">Identifiers</div>
                    <div className="status-row">
                      <span>Agent session</span>
                      <span className="mono small ellip">{session.claudeSessionId}</span>
                    </div>
                    <div className="status-row">
                      <span>Session id</span>
                      <span className="mono small ellip">{session.sessionId}</span>
                    </div>
                  </div>

                  <PanelUsage
                    rpc={rpc}
                    sessionId={session.sessionId}
                    providerId={session.providerId ?? 'claude'}
                  />
                </>
              );
            })()}
        </div>
      )}

      {tab === 'growth' && (
        <div className="panel-body pb-fill">
          {!session && <div className="muted">focus a session</div>}
          {session && metaDir && (
            <FilesPane
              key={`${metaDir}-${reload}`}
              rpc={rpc}
              dir={metaDir}
              onOpenPath={onOpenPath}
              baseLabel={`${session.humanName}'s memory`}
            />
          )}
        </div>
      )}

      {tab === 'git' && (
        <div className="panel-body pb-fill">
          {!session && <div className="muted">focus a session</div>}
          {session && (
            <GitPane
              key={`${session.cwd}-${reload}`}
              rpc={rpc}
              dir={session.cwd}
              onOpenPath={onOpenPath}
            />
          )}
        </div>
      )}

      {tab === 'files' && (
        <div className="panel-body">
          {!session && <div className="muted">focus a session</div>}
          {session && (
            <FilesPane
              key={`${session.cwd}-${reload}`}
              rpc={rpc}
              dir={session.cwd}
              onOpenPath={onOpenPath}
            />
          )}
        </div>
      )}

      {tab === 'browser' && (
        <div className="panel-body">
          {!session && <div className="muted">focus a session</div>}
          {session && <BrowserPane key={session.sessionId} rpc={rpc} sessionId={session.sessionId} />}
        </div>
      )}

      {tab === 'tokens' && (
        <div className="panel-body">
          {!session && <div className="muted">focus a session</div>}
          {session && sessUsage && (
            <>
              <div className="panel-summary">
                <div className="ps-metric">{fmt(sessUsage.outputTokens)}</div>
                <div className="ps-label">output tokens · {session.humanName}'s session</div>
              </div>
              <div className="status-section">
                <div className="status-section-title">This session (API-billed)</div>
                <div className="status-row">
                  <span>API requests</span>
                  <b>{sessUsage.turns.toLocaleString()}</b>
                </div>
                <div className="status-row">
                  <span>Output</span>
                  <b>{fmt(sessUsage.outputTokens)}</b>
                </div>
                <div className="status-row">
                  <span>Input (uncached)</span>
                  <b>{fmt(sessUsage.inputTokens)}</b>
                </div>
                <div className="status-row">
                  <span>Cache read</span>
                  <b>{fmt(sessUsage.cacheReadTokens)}</b>
                </div>
                <div className="status-row">
                  <span>Cache created</span>
                  <b>{fmt(sessUsage.cacheCreationTokens)}</b>
                </div>
                <div className="muted small">
                  Summed from the claude transcript's per-request usage records. ⟳ to refresh.
                </div>
              </div>
            </>
          )}
          {usage && (
            <div className="status-section">
              <div className="status-section-title">
                Ateam internal (flywheel) · ${usage.totals.costUsd.toFixed(2)} /{' '}
                {usage.totals.calls} calls
              </div>
              {usage.entries.slice(0, 20).map((e, i) => (
                <div key={`${e.at}-${i}`} className="rec mono">
                  <span className="muted">{e.at.slice(5, 16).replace('T', ' ')}</span> {e.op}{' '}
                  <span className="muted">
                    in {fmt(e.inputTokens ?? 0)} out {fmt(e.outputTokens ?? 0)}
                    {e.costUsd ? ` $${e.costUsd.toFixed(4)}` : ''}
                  </span>
                </div>
              ))}
              {usage.entries.length === 0 && (
                <div className="muted small">no reflect/distill calls logged yet</div>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
