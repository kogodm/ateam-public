import type { HumanDTO, Result } from '@ateam/contract';
import { FoxWait } from './FoxWait';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { avatarSrc } from './avatars';
import { ICONS } from './railIcons';
import { HumanEdit } from './HumanEdit';
import { Tip } from './Tip';
import { PromptsPane } from './SettingsPrompts';
import { SyncPane } from './SettingsSync';
import { McpPane } from './SettingsMcp';
import { canSubmitRemoteAuth, remoteSignInParams, type RemoteAuthMode } from './remoteAuth';
import {
  canSaveLanSettings,
  isValidLanPassword,
  isValidLanPort,
  lanSettingsPatch,
} from './lanSettings';
import {
  STREAM_FONTS,
  STREAM_SIZE,
  availableStreamFonts,
  type StreamFont,
  clampSize,
  readStreamFont,
  saveStreamFont,
} from './streamFont';
import type { Rpc } from './rpc';

type Tab = 'mcp' | 'general' | 'remote' | 'team' | 'appearance' | 'providers' | 'prompts';
type ThemeChoice = 'dark' | 'light';
type DesktopView = 'terminal' | 'stream';

interface NavItem {
  id: Tab;
  label: string;
  icon: ReactNode;
}

export const SETTINGS_NAV: NavItem[] = [
  { id: 'mcp', label: 'MCP', icon: ICONS.general },
  { id: 'general', label: 'General', icon: ICONS.general },
  { id: 'remote', label: 'Remote', icon: ICONS.remote },
  { id: 'team', label: 'Team', icon: ICONS.team },
  { id: 'appearance', label: 'Appearance', icon: ICONS.appearance },
  { id: 'providers', label: 'Providers', icon: ICONS.providers },
  { id: 'prompts', label: 'Prompts', icon: ICONS.prompt },
];

export function Settings({
  rpc,
  onClose,
  theme,
  setTheme,
  desktopView,
  setDesktopView,
  activeWindowH,
  setActiveWindowH,
}: {
  rpc: Rpc;
  onClose: () => void;
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  desktopView: DesktopView;
  setDesktopView: (v: DesktopView) => void;
  /** "recently active" tree-filter window, hours (24 / 72 / 168 / 360) */
  activeWindowH: number;
  setActiveWindowH: (h: number) => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('general');
  return (
    <div className="settings">
      <aside className="settings-rail">
        <button type="button" className="rail-back" onClick={onClose}>
          ← Back to app
        </button>
        <nav className="rail-nav">
          {SETTINGS_NAV.map((n) => (
            <button
              type="button"
              key={n.id}
              className={n.id === tab ? 'on' : ''}
              onClick={() => setTab(n.id)}
            >
              <span className="icon">{n.icon}</span>
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="settings-body">
        {tab === 'mcp' && <McpPane rpc={rpc} />}
        {tab === 'general' && (
          <GeneralPane rpc={rpc} activeWindowH={activeWindowH} setActiveWindowH={setActiveWindowH} />
        )}
        {tab === 'remote' && <RemoteSettingsPane rpc={rpc} />}
        {tab === 'team' && <TeamPane rpc={rpc} />}
        {tab === 'appearance' && (
          <AppearancePane
            theme={theme}
            setTheme={setTheme}
            desktopView={desktopView}
            setDesktopView={setDesktopView}
          />
        )}
        {tab === 'providers' && <ProvidersPane rpc={rpc} />}
        {tab === 'prompts' && <PromptsPane rpc={rpc} />}
      </main>
    </div>
  );
}

/* ---------------------------- General ---------------------------- */

export function GeneralPane({
  rpc,
  activeWindowH,
  setActiveWindowH,
}: {
  rpc: Rpc;
  activeWindowH: number;
  setActiveWindowH: (h: number) => void;
}): JSX.Element {
  const [counts, setCounts] = useState<{ humans: number; sessions: number; live: number }>({
    humans: 0,
    sessions: 0,
    live: 0,
  });
  useEffect(() => {
    void (async () => {
      const [hs, sl] = await Promise.all([
        rpc.request('human.list', {}),
        rpc.request('session.list', {}),
      ]);
      const all = sl.projects.flatMap((p) => p.sessions);
      setCounts({
        humans: hs.humans.length,
        sessions: all.length,
        live: all.filter((s) => s.state === 'running' || s.state === 'starting').length,
      });
    })();
  }, [rpc]);
  return (
    <>
      <h1 className="page-title">General</h1>
      <p className="page-lede">
        Global behaviour for every session. Changes take effect immediately
        unless noted.
      </p>
      <section className="section">
        <div className="settings-eyebrow">Workspace</div>
        <h3 className="section-title">Overview</h3>
        <p className="section-sub">Snapshot of your Ateam workspace</p>
        <div className="stat-row">
          <div className="stat">
            <div className="stat-n">{counts.humans}</div>
            <div className="stat-l">humans</div>
          </div>
          <div className="stat">
            <div className="stat-n">{counts.sessions}</div>
            <div className="stat-l">sessions</div>
          </div>
          <div className="stat">
            <div className="stat-n">{counts.live}</div>
            <div className="stat-l">live</div>
          </div>
        </div>
      </section>
      <AutoHandoffPane rpc={rpc} />
      <ExperienceCheckpointPane rpc={rpc} />
      <AutoResumePane rpc={rpc} />
      <HibernatePane rpc={rpc} />
      <ProxyPane rpc={rpc} />
      <section className="section">
        <div className="settings-eyebrow">Sidebar</div>
        <h3 className="section-title">
          Recently-active filter
          <Tip>
            The sidebar's ◉ toggle hides sessions whose last real activity (not
            when the tab was created) falls outside this window — Projects and
            Humans views alike. The row's ago badge uses the same clock.
          </Tip>
        </h3>
        <div className="field-row">
          <div className="top">
            <span className="name">Window</span>
            <span className="control window-opts">
              {[
                { h: 24, label: '24h' },
                { h: 72, label: '3d' },
                { h: 168, label: '7d' },
                { h: 360, label: '15d' },
              ].map((o) => (
                <button
                  type="button"
                  key={o.h}
                  className={`window-opt${activeWindowH === o.h ? ' on' : ''}`}
                  onClick={() => setActiveWindowH(o.h)}
                >
                  {o.label}
                </button>
              ))}
            </span>
          </div>
        </div>
      </section>
      <section className="section">
        <div className="settings-eyebrow">About</div>
        <h3 className="section-title">
          Ateam
          <Tip>
            A multi-agent session multiplexer with a self-evolution flywheel — sessions
            curate their own knowledge in-line; the sidecar promotes drops into the
            per-human vault on the next spawn.
          </Tip>
        </h3>
        <div className="about-build">
          <span className="about-version">v{__APP_VERSION__}</span>
          <span className="mono muted">build {__BUILD_ID__}</span>
        </div>
      </section>
    </>
  );
}

export function RemoteSettingsPane({ rpc }: { rpc: Rpc }): JSX.Element {
  const [section, setSection] = useState<'access' | 'sync'>('access');
  return (
    <>
      <h1 className="page-title">Remote</h1>
      <p className="page-lede">
        Manage access to this Ateam from your network or through the relay.
      </p>
      <RemoteSettingsSectionTabs section={section} onChange={setSection} />
      {section === 'access' ? (
        <>
          <LanPane rpc={rpc} />
          <RemotePane rpc={rpc} />
        </>
      ) : (
        <SyncPane rpc={rpc} embedded onOpenRemote={() => setSection('access')} />
      )}
    </>
  );
}

export function RemoteSettingsSectionTabs({
  section,
  onChange,
}: {
  section: 'access' | 'sync';
  onChange: (section: 'access' | 'sync') => void;
}): JSX.Element {
  return (
    <nav className="remote-subnav" aria-label="Remote settings sections">
      <button type="button" aria-pressed={section === 'access'} onClick={() => onChange('access')}>
        Access
      </button>
      <button type="button" aria-pressed={section === 'sync'} onClick={() => onChange('sync')}>
        Sync
      </button>
    </nav>
  );
}

/* --------------------------- Auto-handoff --------------------------- */

function AutoHandoffPane({ rpc }: { rpc: Rpc }): JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [threshold, setThreshold] = useState(680_000);
  const [busy, setBusy] = useState('');
  // Last value we successfully persisted, used as the "is this a real
  // change?" baseline. Previously we compared the input's NEW value
  // against `threshold` state — but onChange already updated `threshold`
  // to that NEW value, so the diff was always 0 and the save never
  // happened. With a ref of the last-saved value this works correctly
  // and survives the AutoHandoffPane unmounting (Settings tab switch).
  const lastSavedThresholdRef = useRef(680_000);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void rpc.request('config.get', {}).then((r) => {
      setEnabled(r.config.autoHandoff.enabled);
      setThreshold(r.config.autoHandoff.thresholdTokens);
      lastSavedThresholdRef.current = r.config.autoHandoff.thresholdTokens;
    });
  }, [rpc]);

  const save = useCallback(
    async (patch: { enabled?: boolean; thresholdTokens?: number }) => {
      setBusy('saving…');
      try {
        const r = await rpc.request('config.set', { autoHandoff: patch });
        setEnabled(r.config.autoHandoff.enabled);
        setThreshold(r.config.autoHandoff.thresholdTokens);
        lastSavedThresholdRef.current = r.config.autoHandoff.thresholdTokens;
        setBusy('saved');
        setTimeout(() => setBusy(''), 800);
      } catch (e) {
        setBusy(e instanceof Error ? e.message : String(e));
      }
    },
    [rpc],
  );

  /** Debounced threshold save — fires 500ms after the user stops
   *  typing. The timeout lives in a closure so it survives an
   *  AutoHandoffPane unmount (e.g. user types `120` then immediately
   *  switches tab); only the value at trigger time matters. We do
   *  the validity check at fire time, not at scheduling, in case
   *  the user types through invalid intermediate values. */
  const scheduleThresholdSave = useCallback(
    (v: number) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        if (
          Number.isFinite(v) &&
          v >= 10_000 &&
          v <= 1_000_000 &&
          v !== lastSavedThresholdRef.current
        ) {
          void save({ thresholdTokens: v });
        }
      }, 500);
    },
    [save],
  );

  return (
    <section className="section">
      <div className="settings-eyebrow">Context</div>
      <h3 className="section-title">
        Auto-handoff
        <Tip>
          When a session's estimated context usage crosses the threshold, Ateam
          automatically invokes Matt Pocock's <code>handoff</code> skill — the
          session writes a handoff document to your OS temp dir so a fresh agent
          can pick up the work without starting from zero.
        </Tip>
      </h3>
      <div className="toggle-row">
        <div className="body">
          <div className="name">
            Enable auto-handoff
            <Tip>Off = you can still trigger a handoff manually from a session.</Tip>
          </div>
        </div>
        <button
          type="button"
          className={`toggle-switch ${enabled ? 'on' : ''}`}
          onClick={() => void save({ enabled: !enabled })}
        />
      </div>
      <label className="field-row">
        <div className="top">
          <span className="name">
            Threshold
            <Tip>
            Estimated tokens. Models accept up to ~1M; keep it at or below 750K so the handoff
            doc and the successor's first turn still have room.
            </Tip>
          </span>
          <span className="control">
        <input
          type="number"
          min={10_000}
          step={5_000}
          value={threshold}
          onChange={(e) => {
            const v = Number(e.target.value);
            setThreshold(v);
            scheduleThresholdSave(v);
          }}
          onBlur={(e) => {
            // belt + braces: if blur happens before the debounce fires
            // (e.g. user types then immediately clicks elsewhere), flush
            // the save now so we don't wait the remaining ms.
            const v = Number(e.target.value);
            if (
              Number.isFinite(v) &&
              v >= 10_000 &&
              v !== lastSavedThresholdRef.current
            ) {
              if (debounceRef.current) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
              }
              void save({ thresholdTokens: v });
            }
          }}
        />
        <button
          type="button"
          className="threshold-save"
          disabled={
            !Number.isFinite(threshold) ||
            threshold < 10_000 ||
            threshold === lastSavedThresholdRef.current ||
            !!busy
          }
          onClick={() => {
            if (debounceRef.current) {
              clearTimeout(debounceRef.current);
              debounceRef.current = null;
            }
            void save({ thresholdTokens: threshold });
          }}
        >
          Save
        </button>
          </span>
        </div>
        {threshold > 750_000 && (
          <em className="field-flag">Above the 750K recommendation</em>
        )}
        {busy ? (
          <em className="field-flag info">{busy}</em>
        ) : threshold !== lastSavedThresholdRef.current ? (
          <em className="field-flag info">Unsaved</em>
        ) : null}
      </label>
    </section>
  );
}

/** Once per compaction cycle, a session past this many tokens is told to
 *  write what it has learned into its knowledge folder, and carries on — it
 *  is not replaced. Claude Code compacts on its own near the end of the
 *  window and keeps only a summary; this saves the lessons first. */
function ExperienceCheckpointPane({ rpc }: { rpc: Rpc }): JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [threshold, setThreshold] = useState(850_000);
  const [saved, setSaved] = useState(850_000);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    void rpc.request('config.get', {}).then((r) => {
      setEnabled(r.config.experienceCheckpoint.enabled);
      setThreshold(r.config.experienceCheckpoint.thresholdTokens);
      setSaved(r.config.experienceCheckpoint.thresholdTokens);
    });
  }, [rpc]);

  const save = useCallback(
    async (patch: { enabled?: boolean; thresholdTokens?: number }) => {
      setBusy('saving…');
      try {
        const r = await rpc.request('config.set', { experienceCheckpoint: patch });
        setEnabled(r.config.experienceCheckpoint.enabled);
        setThreshold(r.config.experienceCheckpoint.thresholdTokens);
        setSaved(r.config.experienceCheckpoint.thresholdTokens);
        setBusy('saved');
        setTimeout(() => setBusy(''), 800);
      } catch (e) {
        setBusy(e instanceof Error ? e.message : String(e));
      }
    },
    [rpc],
  );
  const valid = Number.isFinite(threshold) && threshold >= 10_000 && threshold <= 1_000_000;

  return (
    <section className="section">
      <h3 className="section-title">
        Experience checkpoint
        <Tip>
          Claude Code compacts a full conversation on its own and keeps only a summary. Past the
          threshold, each session is told once to write what it has learned into its teammate's
          knowledge folder while the whole conversation is still in context — then it carries on.
          Nothing is replaced and nothing running is stopped.
        </Tip>
      </h3>
      <div className="toggle-row">
        <div className="body">
          <div className="name">Save experience before compaction</div>
        </div>
        <button
          type="button"
          className={`toggle-switch ${enabled ? 'on' : ''}`}
          onClick={() => void save({ enabled: !enabled })}
        />
      </div>
      <label className="field-row">
        <div className="top">
          <span className="name">
            Threshold
            <Tip>
              Estimated tokens. On a 1M window Claude compacts at about 967K; 850K leaves room for
              the saving turn. A session on a 200K window never gets this far — its compaction is
              still told to keep the lessons in its summary.
            </Tip>
          </span>
          <span className="control">
            <input
              type="number"
              min={10_000}
              step={10_000}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              onBlur={() => {
                if (valid && threshold !== saved) void save({ thresholdTokens: threshold });
              }}
            />
            <button
              type="button"
              className="threshold-save"
              disabled={!valid || threshold === saved || !!busy}
              onClick={() => void save({ thresholdTokens: threshold })}
            >
              Save
            </button>
          </span>
        </div>
        {busy ? (
          <em className="field-flag info">{busy}</em>
        ) : threshold !== saved ? (
          <em className="field-flag info">Unsaved</em>
        ) : null}
      </label>
    </section>
  );
}

/* --------------------------- Hibernation --------------------------- */

function AutoResumePane({ rpc }: { rpc: Rpc }): JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    void rpc.request('config.get', {}).then((r) => {
      setEnabled(r.config.autoResume);
    });
  }, [rpc]);

  const save = useCallback(
    async (next: boolean) => {
      setBusy('saving…');
      try {
        const r = await rpc.request('config.set', { autoResume: next });
        setEnabled(r.config.autoResume);
        setBusy('saved');
        setTimeout(() => setBusy(''), 800);
      } catch (e) {
        setBusy(e instanceof Error ? e.message : String(e));
      }
    },
    [rpc],
  );

  return (
    <section className="section">
      <div className="settings-eyebrow">Startup</div>
      <h3 className="section-title">
        Auto-resume
        <Tip>
          Bring every saved session back the moment a client connects — no
          confirmation dialog. Lets the app restart unattended (a build script, a
          crash) and be fully back before you reach for it from a phone. Turn off
          to pick sessions by hand on each start.
        </Tip>
      </h3>
      <div className="toggle-row">
        <div className="body">
          <div className="name">
            Restore all without asking
            <Tip>Off = show the pick-and-choose dialog on each start.</Tip>
          </div>
          {busy && <div className="desc">{busy}</div>}
        </div>
        <button
          type="button"
          className={`toggle-switch ${enabled ? 'on' : ''}`}
          onClick={() => void save(!enabled)}
        />
      </div>
    </section>
  );
}

function HibernatePane({ rpc }: { rpc: Rpc }): JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [idleHours, setIdleHours] = useState(24);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    void rpc.request('config.get', {}).then((r) => {
      setEnabled(r.config.hibernate.enabled);
      setIdleHours(r.config.hibernate.idleHours);
    });
  }, [rpc]);

  const save = useCallback(
    async (patch: { enabled?: boolean; idleHours?: number }) => {
      setBusy('saving…');
      try {
        const r = await rpc.request('config.set', { hibernate: patch });
        setEnabled(r.config.hibernate.enabled);
        setIdleHours(r.config.hibernate.idleHours);
        setBusy('saved');
        setTimeout(() => setBusy(''), 800);
      } catch (e) {
        setBusy(e instanceof Error ? e.message : String(e));
      }
    },
    [rpc],
  );

  return (
    <section className="section">
      <div className="settings-eyebrow">Resources</div>
      <h3 className="section-title">
        Session hibernation
        <Tip>
          Each live session is a full claude process (~300 MB). Sessions with no
          conversation inside the window release their process — they stay in the
          tree, dimmed, and wake on click with the conversation intact. Restore
          applies the same rule instead of booting everything.
        </Tip>
      </h3>
      <div className="toggle-row">
        <div className="body">
          <div className="name">
            Hibernate idle sessions
            <Tip>Applies to running sessions and to restore.</Tip>
          </div>
          {busy && <div className="desc">{busy}</div>}
        </div>
        <button
          type="button"
          className={`toggle-switch ${enabled ? 'on' : ''}`}
          onClick={() => void save({ enabled: !enabled })}
        />
      </div>
      <div className="field-row">
        <div className="top">
          <span className="name">
            Idle window
            <Tip>No new messages for this long and the session's process is released.</Tip>
          </span>
          <span className="control window-opts">
            {[
              { h: 6, label: '6h' },
              { h: 12, label: '12h' },
              { h: 24, label: '24h' },
              { h: 72, label: '3d' },
            ].map((o) => (
              <button
                type="button"
                key={o.h}
                className={`window-opt${idleHours === o.h ? ' on' : ''}`}
                disabled={!enabled}
                onClick={() => void save({ idleHours: o.h })}
              >
                {o.label}
              </button>
            ))}
          </span>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ Proxy ------------------------------ */

/** Relaunch the whole app so every session respawns (resume keeps their
 *  transcripts) with the new proxy env. No-op outside Tauri (browser e2e). */
async function relaunchApp(): Promise<void> {
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch {
    /* not running inside Tauri — nothing to relaunch */
  }
}

function ProxyPane({ rpc }: { rpc: Rpc }): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState('');
  // restart-to-apply prompt, shown right after the toggle flips ON
  const [showRestart, setShowRestart] = useState(false);
  // last persisted URL — the "is this a real change?" baseline (same
  // pattern as AutoHandoffPane's threshold ref).
  const lastSavedUrlRef = useRef('');

  // the field is host:port only — schemes are derived at spawn time
  // (http:// for HTTP(S)_PROXY, socks5:// for ALL_PROXY). Legacy configs
  // that stored a full URL display stripped.
  const stripScheme = (s: string): string => s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');

  useEffect(() => {
    void rpc.request('config.get', {}).then((r) => {
      setEnabled(r.config.proxy.enabled);
      setUrl(stripScheme(r.config.proxy.url));
      lastSavedUrlRef.current = stripScheme(r.config.proxy.url);
    });
  }, [rpc]);

  const save = useCallback(
    async (patch: { enabled?: boolean; url?: string }) => {
      setBusy('saving…');
      try {
        const r = await rpc.request('config.set', { proxy: patch });
        setEnabled(r.config.proxy.enabled);
        setUrl(stripScheme(r.config.proxy.url));
        lastSavedUrlRef.current = stripScheme(r.config.proxy.url);
        setBusy('saved');
        setTimeout(() => setBusy(''), 800);
      } catch (e) {
        setBusy(e instanceof Error ? e.message : String(e));
      }
    },
    [rpc],
  );

  const trimmed = stripScheme(url.trim());
  const urlValid = trimmed === '' || /^[\w.-]+:\d+$/.test(trimmed);
  const dirty = trimmed !== lastSavedUrlRef.current;

  return (
    <section className="section">
      <div className="settings-eyebrow">Network</div>
      <h3 className="section-title">
        Proxy
        <Tip>
          Route every session's network traffic through a proxy. Sets{' '}
          <code>HTTP_PROXY</code>/<code>HTTPS_PROXY</code> in each session's
          environment — applies to <b>newly started</b> sessions; already-running
          ones keep the environment they launched with.
        </Tip>
      </h3>
      <div className="toggle-row">
        <div className="body">
          <div className="name">
            Enable proxy
            <Tip>Overrides any proxy exported by your shell profile.</Tip>
          </div>
        </div>
        <button
          type="button"
          className={`toggle-switch ${enabled ? 'on' : ''}`}
          onClick={() => {
            const turningOn = !enabled;
            void save({ enabled: turningOn }).then(() => {
              if (turningOn) setShowRestart(true);
            });
          }}
        />
      </div>
      <label className="field-row">
        <div className="top">
          <span className="name">
            Proxy address
            <Tip>
            IP:port of your local proxy (Clash/V2Ray mixed port). Sessions get http:// for
            HTTP/HTTPS and socks5:// for ALL_PROXY automatically.
            </Tip>
          </span>
          <span className="control">
        <input
          type="text"
          placeholder="127.0.0.1:7890"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => {
            if (urlValid && dirty) void save({ url: trimmed });
          }}
        />
        <button
          type="button"
          className="threshold-save"
          disabled={!urlValid || !dirty || !!busy}
          onClick={() => void save({ url: trimmed })}
        >
          Save
        </button>
          </span>
        </div>
        {!urlValid && <em className="field-flag">⚠ Expected host:port</em>}
        {enabled && !trimmed && (
          <em className="field-flag">⚠ Enabled but empty — no proxy is applied</em>
        )}
        {busy ? (
          <em className="field-flag info">{busy}</em>
        ) : dirty ? (
          <em className="field-flag info">Unsaved</em>
        ) : null}
      </label>
      {showRestart && (
        <div className="modal-bg" onClick={() => setShowRestart(false)}>
          <div className="modal handoff-confirm" onClick={(e) => e.stopPropagation()}>
            <h3>🔁 Restart to apply the proxy</h3>
            <p className="handoff-confirm-body">
              Running sessions keep the environment they were launched with, so
              the proxy only reaches sessions started from now on. Restart Ateam
              to apply it everywhere — your sessions are saved and resume
              automatically, nothing is lost.
            </p>
            <div className="handoff-confirm-actions">
              <button type="button" className="primary" onClick={() => void relaunchApp()}>
                Restart now
              </button>
              <button type="button" onClick={() => setShowRestart(false)}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------ LAN access ------------------------------ */

function LanPane({ rpc }: { rpc: Rpc }): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [passwordSet, setPasswordSet] = useState(false);
  const [port, setPort] = useState('4380');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<{ running: boolean; urls: string[]; error?: string }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageInfo, setMessageInfo] = useState(false);
  const [dialog, setDialog] = useState<'enable' | 'configure' | null>(null);
  const [dialogError, setDialogError] = useState('');
  const lastSavedPortRef = useRef('4380');

  const refresh = useCallback(async () => {
    const s = await rpc.request('lan.status', {});
    setStatus({ running: s.running, urls: s.urls, ...(s.error ? { error: s.error } : {}) });
    setEnabled(s.enabled);
    setPasswordSet(s.passwordSet);
    setPort(String(s.port));
    lastSavedPortRef.current = String(s.port);
  }, [rpc]);

  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  const save = useCallback(
    async (
      patch: { enabled?: boolean; port?: number; password?: string },
      inDialog = false,
    ) => {
      const cleanPatch =
        patch.password === undefined ? patch : { ...patch, password: patch.password.trim() };
      setBusy(true);
      setMessage('');
      setMessageInfo(false);
      setDialogError('');
      try {
        await rpc.request('config.set', { lan: cleanPatch });
        if (cleanPatch.enabled !== undefined) setEnabled(cleanPatch.enabled);
        if (cleanPatch.port !== undefined) {
          const savedPort = String(cleanPatch.port);
          setPort(savedPort);
          lastSavedPortRef.current = savedPort;
        }
        if (cleanPatch.password !== undefined) setPasswordSet(true);
        setPassword('');
        if (inDialog) setDialog(null);
        try {
          await refresh();
        } catch {
          setMessage('LAN settings saved. Reopen Settings to refresh status.');
          setMessageInfo(true);
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        if (inDialog) setDialogError(error);
        else {
          setMessage(error);
          setMessageInfo(false);
        }
      } finally {
        setBusy(false);
      }
    },
    [rpc, refresh],
  );

  const portNum = Number(port.trim());
  const portValid = isValidLanPort(port);
  const pwTrimmed = password.trim();
  const pwValid = isValidLanPassword(password);
  const dialogCanSave =
    dialog !== null && canSaveLanSettings({ mode: dialog, password, port }, busy);
  const openDialog = (next: 'enable' | 'configure') => {
    setPort(lastSavedPortRef.current);
    setPassword('');
    setDialogError('');
    setMessage('');
    setDialog(next);
  };
  const closeDialog = () => {
    if (busy) return;
    setDialog(null);
    setPassword('');
    setPort(lastSavedPortRef.current);
    setDialogError('');
  };

  useEffect(() => {
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) closeDialog();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dialog, busy]);

  const submitDialog = () => {
    if (!dialogCanSave || !dialog) return;
    void save(lanSettingsPatch({ mode: dialog, password, port }), true);
  };

  return (
    <section className="section">
      <div className="settings-eyebrow">Network</div>
      <h3 className="section-title">LAN access</h3>
      {!enabled && <p className="desc lan-lede">Make this Ateam available to devices on your local network.</p>}
      <div className="toggle-row">
        <div className="body">
          <div className="name">
            Enable LAN access
          </div>
        </div>
        <button
          type="button"
          className={`toggle-switch ${enabled ? 'on' : ''}`}
          onClick={() => {
            if (enabled) {
              void save({ enabled: false });
              return;
            }
            if (passwordSet) void save({ enabled: true });
            else openDialog('enable');
          }}
          disabled={busy}
          title={enabled ? 'Disable LAN access' : 'Enable LAN access'}
          aria-label={enabled ? 'Disable LAN access' : 'Enable LAN access'}
        />
      </div>
      {enabled && (
        <div className="lan-enabled-details">
          <div className="lan-security-note">
            Anyone with the password can run commands as you on this machine. Use a strong
            password and trusted networks only; LAN connections use plain HTTP.
          </div>
          <div className="field-row lan-status">
            <div className="desc">
              {!status
                ? 'Checking LAN service…'
                : status.running
                  ? status.urls.length
                    ? <>Open from another device: {status.urls.map((url) => <code key={url} className="mono">{url}</code>)}</>
                    : 'Running, but no LAN IPv4 address found — is this machine on a network?'
                  : 'Not running.'}
              {status?.error && <em className="field-flag">{status.error}</em>}
            </div>
            <button type="button" className="threshold-save lan-configure" disabled={busy} onClick={() => openDialog('configure')}>
              Configure LAN
            </button>
          </div>
        </div>
      )}
      {message && <em className={`field-flag${messageInfo ? ' info' : ''}`}>{message}</em>}
      {dialog && (
        <div className="modal-bg lan-modal-bg" onClick={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}>
          <section className="modal lan-modal" role="dialog" aria-modal="true" aria-labelledby="lan-dialog-title">
            <header className="lan-modal-header">
              <h3 id="lan-dialog-title">{dialog === 'enable' ? 'Enable LAN access' : 'Configure LAN'}</h3>
              <button type="button" className="remote-auth-close" title="Close" aria-label="Close LAN settings dialog" disabled={busy} onClick={closeDialog}>×</button>
            </header>
            <div className="lan-security-note">
              Anyone with the password can run commands as you on this machine. Use a strong
              password and trusted networks only; LAN connections use plain HTTP.
            </div>
            <form className="lan-dialog-form" onSubmit={(event) => { event.preventDefault(); submitDialog(); }}>
              <label htmlFor="lan-dialog-password">Password {dialog === 'configure' && <span className="muted">(leave blank to keep the current password)</span>}</label>
              <input
                id="lan-dialog-password"
                type="password"
                placeholder={dialog === 'enable' ? 'At least 4 characters' : 'Leave blank to keep current password'}
                value={password}
                autoComplete="new-password"
                required={dialog === 'enable'}
                minLength={dialog === 'enable' || pwTrimmed ? 4 : undefined}
                autoFocus={dialog === 'enable'}
                onChange={(event) => setPassword(event.target.value)}
              />
              {dialog === 'enable' && !pwValid && (
                <em className="field-flag">Enter a password with at least 4 characters.</em>
              )}
              {dialog === 'configure' && !!pwTrimmed && !pwValid && (
                <em className="field-flag">Use at least 4 characters to replace the current password.</em>
              )}
              <label htmlFor="lan-dialog-port">Port</label>
              <input
                id="lan-dialog-port"
                type="text"
                inputMode="numeric"
                value={port}
                required
                onChange={(event) => setPort(event.target.value)}
              />
              {!portValid && <em className="field-flag">Expected a port between 1024 and 65535.</em>}
              {dialogError && <em className="field-flag" role="alert">{dialogError}</em>}
              <footer className="lan-modal-actions">
                <button type="button" disabled={busy} onClick={closeDialog}>Cancel</button>
                <button type="submit" className="threshold-save" disabled={!dialogCanSave}>
                  {busy ? 'Saving…' : dialog === 'enable' ? 'Enable' : 'Save changes'}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}

/* ------------------------------ Remote access ------------------------------ */

function RemotePane({ rpc }: { rpc: Rpc }): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [st, setSt] = useState<{
    connected: boolean;
    clientPort?: number;
    url?: string;
    lastError?: string;
  } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<RemoteAuthMode>('signin');
  const [authError, setAuthError] = useState('');
  // `busy` is "an operation is in flight" and `msg` is "here is what happened".
  // They used to be ONE string, so a failed sign-in parked its error message in
  // the flag that disables the button — the pane wedged and the only way to try
  // again was to close Settings and reopen it.
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [failed, setFailed] = useState(false);
  const [lanPassword, setLanPassword] = useState('');

  const refresh = useCallback(async () => {
    const [c, r] = await Promise.all([
      rpc.request('config.get', {}),
      rpc.request('remote.status', {}),
    ]);
    setEnabled(c.config.remote.enabled);
    setDeviceId(c.config.remote.deviceId);
    setSt({
      connected: r.connected,
      ...(r.clientPort ? { clientPort: r.clientPort } : {}),
      ...(r.url ? { url: r.url } : {}),
      ...(r.lastError ? { lastError: r.lastError } : {}),
    });
    setMsg((current) =>
      current === 'Signed in; status will refresh shortly.' ? '' : current,
    );
  }, [rpc]);

  useEffect(() => {
    void refresh().catch(() => {});
    const t = setInterval(() => void refresh().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  /** One button for the whole thing: the account sign-in registers this
   *  machine, switches LAN access on (minting a password if there is none) and
   *  opens the tunnel. The relay address is built in — asking for it turned a
   *  two-field form into a five-field one, and it is the same address every
   *  time. */
  const signIn = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    setAuthError('');
    try {
      const r = await rpc.request('remote.signIn', {
        ...remoteSignInParams({ mode: authMode, email, password, invite }),
      });
      setDeviceId(r.deviceId);
      setEnabled(true);
      setPassword('');
      setInvite('');
      setLanPassword(r.lanPassword ?? '');
      setMsg(`connected · device ${r.deviceId}`);
      setFailed(false);
      setEmail('');
      setAuthOpen(false);
      setAuthError('');
      try {
        await refresh();
      } catch {
        setMsg('Signed in; status will refresh shortly.');
        setFailed(false);
      }
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false); // ALWAYS — a failure must leave the form usable
    }
  }, [rpc, email, password, invite, authMode, refresh]);

  const setRemote = useCallback(
    async (patch: { enabled?: boolean }) => {
      setBusy(true);
      setFailed(false);
      try {
        await rpc.request('config.set', { remote: patch });
        await refresh();
        setMsg('');
      } catch (e) {
        setFailed(true);
        setMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [rpc, refresh],
  );

  const registered = !!deviceId;
  const canSignIn = canSubmitRemoteAuth({ mode: authMode, email, password, invite, busy });
  const openAuth = useCallback((mode: 'signin' | 'register' = 'signin') => {
    setAuthMode(mode);
    setAuthError('');
    setAuthOpen(true);
  }, []);
  const closeAuth = useCallback(() => {
    if (busy) return;
    setAuthOpen(false);
    setEmail('');
    setPassword('');
    setInvite('');
    setAuthError('');
  }, [busy]);

  useEffect(() => {
    if (!authOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) closeAuth();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [authOpen, busy, closeAuth]);
  const publicUrl =
    st?.url && st.clientPort
      ? `https://${st.url.replace(/^wss?:\/\//, '').replace(/[:/].*$/, '')}:${st.clientPort}`
      : '';

  return (
    <section className="section">
      <div className="settings-eyebrow">Network</div>
      <h3 className="section-title">
        Remote access
        <Tip>
          Reach this machine from anywhere. Sign in with your account and this
          machine registers itself, turns LAN access on and keeps an outbound
          tunnel open — then open the same account on your phone and pick it.
        </Tip>
      </h3>

      <div className="toggle-row">
        <div className="body">
          <div className="name">Connected</div>
          <div className="desc">
            {!registered
              ? 'Sign in or register to connect this machine.'
              : st?.connected
                ? `Device ${deviceId}${publicUrl ? ` · open ${publicUrl} on your phone` : ''}`
                : enabled
                  ? `Connecting… ${st?.lastError ? `(${st.lastError})` : ''}`
                  : 'Off.'}
          </div>
        </div>
        <button
          type="button"
          className={`toggle-switch ${enabled ? 'on' : ''}`}
          onClick={() =>
            registered ? void setRemote({ enabled: !enabled }) : openAuth()
          }
          disabled={busy}
          title={registered ? (enabled ? 'Disable remote access' : 'Enable remote access') : 'Sign in or register to connect this machine'}
          aria-label={registered ? (enabled ? 'Disable remote access' : 'Enable remote access') : 'Sign in or register to connect this machine'}
        />
      </div>
      <div className="remote-auth-links">
        {!registered ? (
          <button type="button" className="remote-auth-link" onClick={() => openAuth()}>
            Sign in / Register
          </button>
        ) : (
          <button type="button" className="remote-auth-link" onClick={() => openAuth()} disabled={busy}>
            Sign in with another account
          </button>
        )}
      </div>
      {msg && <em className={`field-flag${failed ? '' : ' info'}`}>{msg}</em>}
      {lanPassword && (
        <div className="desc remote-auth-lan-password">
          LAN access was off, so a password was generated for it:{' '}
          <code className="mono">{lanPassword}</code> — only needed by someone
          opening this machine over the local network; change it above.
        </div>
      )}
      {registered && <InviteRow rpc={rpc} />}

      {authOpen && (
        <div
          className="modal-bg remote-auth-bg"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeAuth();
          }}
        >
          <section
            className="modal remote-auth-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-auth-title"
          >
            <header className="remote-auth-header">
              <h3 id="remote-auth-title">Remote account</h3>
              <button
                type="button"
                className="remote-auth-close"
                title="Close"
                aria-label="Close remote account dialog"
                disabled={busy}
                onClick={closeAuth}
              >
                ×
              </button>
            </header>
            <div className="remote-auth-tabs" role="tablist" aria-label="Remote account action">
              <button
                type="button"
                role="tab"
                aria-selected={authMode === 'signin'}
                className={authMode === 'signin' ? 'active' : ''}
                disabled={busy}
                onClick={() => { setAuthMode('signin'); setAuthError(''); }}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={authMode === 'register'}
                className={authMode === 'register' ? 'active' : ''}
                disabled={busy}
                onClick={() => { setAuthMode('register'); setAuthError(''); }}
              >
                Register
              </button>
            </div>
            <form
              className="remote-auth-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (canSignIn) void signIn();
              }}
            >
              <label htmlFor="remote-auth-email">Email</label>
              <input
                id="remote-auth-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                autoFocus
                autoComplete="email"
                spellCheck={false}
                required
                onChange={(event) => setEmail(event.target.value)}
              />
              <label htmlFor="remote-auth-password">Password</label>
              <input
                id="remote-auth-password"
                type="password"
                placeholder="At least 8 characters"
                value={password}
                autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                minLength={8}
                required
                onChange={(event) => setPassword(event.target.value)}
              />
              {authMode === 'register' && (
                <>
                  <label htmlFor="remote-auth-invite">Invite code</label>
                  <input
                    id="remote-auth-invite"
                    type="text"
                    placeholder="Invite code"
                    value={invite}
                    autoComplete="off"
                    spellCheck={false}
                    required
                    onChange={(event) => setInvite(event.target.value)}
                  />
                </>
              )}
              {authError && <em className="field-flag remote-auth-error" role="alert">{authError}</em>}
              <button type="submit" className="threshold-save remote-auth-submit" disabled={!canSignIn}>
                {busy
                  ? authMode === 'register' ? 'Registering…' : 'Signing in…'
                  : authMode === 'register' ? 'Register & connect' : 'Sign in & connect'}
              </button>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}

/** Mint an invite code for someone else's new relay account; this machine's
 *  sign-in is the authorization. */
function InviteRow({ rpc }: { rpc: Rpc }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const create = async () => {
    setBusy(true);
    setError('');
    setCode('');
    try {
      const r = await rpc.request('remote.createInvite', {});
      setCode(`${r.code} · single use · expires ${new Date(r.expiresAt).toLocaleDateString()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="field-row">
      <div className="top">
        <span className="name">Invite someone</span>
        <span className="control">
          <button
            type="button"
            className="threshold-save"
            disabled={busy}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create invite code'}
          </button>
        </span>
      </div>
      <div className="desc">
        A new account on the relay needs an invite code. The code is shown once; share it with
        the person who signs in.
      </div>
      {code && <code className="mono">{code}</code>}
      {error && <em className="field-flag">{error}</em>}
    </div>
  );
}

/* --------------------- Knowledge-base browser --------------------- */

const KIND_LABEL: Record<string, string> = {
  skill: 'Skill',
  knowledge: 'Knowledge',
  experience: 'Experience',
};

/**
 * Modal browser over one human's meta knowledge base: entry list on the left,
 * the selected file's raw markdown on the right. Content is fetched per click
 * via `file.read` (the same RPC the File view uses) — nothing is preloaded, so
 * opening the modal costs one render, not N file reads.
 */
function MetaBrowser({
  rpc,
  human,
  meta,
  onClose,
}: {
  rpc: Rpc;
  human: HumanDTO;
  meta?: Result<'human.meta'>;
  onClose: () => void;
}): JSX.Element {
  const entries = meta?.entries ?? [];
  // meta.md is offered as the first row so the index itself is readable too
  const rows = [
    ...(meta?.index ? [{ kind: 'index' as const, name: 'meta.md', path: meta.indexPath }] : []),
    ...entries,
  ];
  const [sel, setSel] = useState<string>(rows[0]?.path ?? '');
  const [text, setText] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sel) return;
    let live = true;
    setLoading(true);
    void rpc
      .request('file.read', { path: sel })
      .then((r) => {
        if (!live) return;
        setText(r.kind === 'text' ? (r.text ?? '') : `(${r.kind} — no text preview)`);
      })
      .catch((e) => {
        if (live) setText(`Read failed: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false; // a slow read must not overwrite a newer selection
    };
  }, [rpc, sel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="task-modal-backdrop" onClick={onClose}>
      <div className="meta-modal" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-head">
          <span className="task-modal-title">
            {human.name}'s knowledge base <span className="muted small">({entries.length} entries)</span>
          </span>
          <button type="button" className="task-modal-close" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="meta-body">
          <div className="meta-list">
            {rows.length === 0 && <div className="muted small">(empty)</div>}
            {rows.map((r) => (
              <button
                key={r.path}
                type="button"
                className={`meta-item${sel === r.path ? ' is-sel' : ''}`}
                onClick={() => setSel(r.path)}
                title={r.path}
              >
                <span className={`meta-kind k-${r.kind}`}>
                  {r.kind === 'index' ? 'Index' : KIND_LABEL[r.kind]}
                </span>
                <span className="meta-name">{r.name}</span>
              </button>
            ))}
          </div>
          <div className="meta-preview">
            {loading ? <div className="muted small">loading…</div> : <pre>{text}</pre>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Team ------------------------------ */

function TeamPane({ rpc }: { rpc: Rpc }): JSX.Element {
  const [humans, setHumans] = useState<HumanDTO[]>([]);
  // What each human has actually accumulated, from the LIVE meta knowledge
  // base. (The old `agent.growth` AssetStore counts are frozen at zero for
  // everyone whose knowledge was written after the memory switch, which is
  // why this card used to claim "0 exp / no domains" for well-stocked humans.)
  const [meta, setMeta] = useState<Record<string, Result<'human.meta'>>>({});
  // open HumanEdit on a specific human (or '' = new). Null = list view.
  const [editing, setEditing] = useState<{ id: string; isNew: boolean } | null>(null);
  // id of the human whose experience summary is currently regenerating.
  const [summarizing, setSummarizing] = useState<string | null>(null);
  // knowledge-base browser modal (null = closed)
  const [browsing, setBrowsing] = useState<{
    human: HumanDTO;
    meta?: Result<'human.meta'>;
  } | null>(null);

  const regen = useCallback(
    async (id: string) => {
      setSummarizing(id);
      try {
        const r = await rpc.request('human.summarize', { id });
        setHumans((prev) => prev.map((x) => (x.id === id ? r.human : x)));
      } catch {
        /* best-effort: leave the existing summary untouched */
      } finally {
        setSummarizing(null);
      }
    },
    [rpc],
  );

  const load = useCallback(async () => {
    const r = await rpc.request('human.list', {});
    setHumans(r.humans);
    const m: Record<string, Result<'human.meta'>> = {};
    await Promise.all(
      r.humans.map(async (h) => {
        try {
          m[h.id] = await rpc.request('human.meta', { humanId: h.id });
        } catch {
          /* skip */
        }
      }),
    );
    setMeta(m);
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  if (editing) {
    return (
      <HumanEdit
        rpc={rpc}
        humanId={editing.id}
        isNew={editing.isNew}
        onBack={() => {
          setEditing(null);
          void load();
        }}
        onSaved={(id) => {
          // after a successful create, swap from "new" to "edit" so the rest
          // of the page (skills/market) becomes available without leaving.
          setEditing({ id, isNew: false });
          void load();
        }}
      />
    );
  }

  return (
    <>
      <h1 className="page-title">Team</h1>
      <section className="section">
        <div className="section-head">
          <div>
            <h3 className="section-title">
              Humans
              <Tip>
                Long-lived virtual people. Each accumulates skills, knowledge and
                experiences across sessions and projects.
              </Tip>
            </h3>
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => setEditing({ id: '', isNew: true })}
          >
            ＋ New human
          </button>
        </div>

        <div className="cards">
          {humans.length === 0 && (
            <div className="muted center">no humans yet — ＋ New human</div>
          )}
          {humans.map((h) => {
            const m = meta[h.id];
            const es = m?.entries ?? [];
            const nSkills = es.filter((e) => e.kind === 'skill').length;
            const nKnow = es.filter((e) => e.kind === 'knowledge').length;
            const nExp = es.filter((e) => e.kind === 'experience').length;
            const hasMeta = es.length > 0 || !!m?.index;
            return (
              <div key={h.id} className="card person-card">
                <div className="card-head">
                  <img
                    className="person-avatar"
                    src={avatarSrc(h.avatarId)}
                    alt=""
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = avatarSrc(undefined);
                    }}
                  />
                  <div className="person-id">
                    <div className="card-name">
                      <b>{h.name}</b> <span className="role-tag">{h.role}</span>
                    </div>
                    <span className="muted small">
                      {h.projects.length} project{h.projects.length === 1 ? '' : 's'} ·{' '}
                      {nSkills} skills · {nKnow} knowledge · {nExp} exp
                    </span>
                  </div>
                  <button
                    type="button"
                    className="card-edit"
                    onClick={() => setEditing({ id: h.id, isNew: false })}
                  >
                    Edit
                  </button>
                </div>
                {!hasMeta && <div className="muted small">No knowledge accumulated yet</div>}
                {h.experienceSummary?.text && (
                  <p className="person-summary">{h.experienceSummary.text}</p>
                )}
                <div className="person-foot">
                  {hasMeta && (
                    <button
                      type="button"
                      className="card-edit"
                      title="Browse this human's knowledge base (skills / knowledge / experiences) with source preview"
                      onClick={() => setBrowsing({ human: h, meta: m })}
                    >
                      <span className="btn-icon">{ICONS.book}</span>
                      Knowledge base · {es.length}
                    </button>
                  )}
                  <button
                    type="button"
                    className="card-edit"
                    disabled={summarizing === h.id || !hasMeta}
                    title={
                      hasMeta
                        ? 'Re-summarize from this human\'s meta knowledge base (meta.md + skills/knowledge/experiences)'
                        : 'Nothing accumulated yet to summarize'
                    }
                    onClick={() => void regen(h.id)}
                  >
                    {summarizing === h.id ? (
                      <FoxWait size={16} />
                    ) : (
                      'Regenerate summary'
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      {browsing && (
        <MetaBrowser
          rpc={rpc}
          human={browsing.human}
          meta={browsing.meta}
          onClose={() => setBrowsing(null)}
        />
      )}
    </>
  );
}

/* ---------------------------- Appearance ---------------------------- */

function AppearancePane({
  theme,
  setTheme,
  desktopView,
  setDesktopView,
}: {
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  desktopView: DesktopView;
  setDesktopView: (v: DesktopView) => void;
}): JSX.Element {
  return (
    <>
      <h1 className="page-title">Appearance</h1>
      <section className="section">
        <h3 className="section-title">Theme</h3>
        <p className="section-sub">Choose how Ateam looks</p>
        <div className="radio-cards">
          <button
            type="button"
            className={`radio-card ${theme === 'dark' ? 'on' : ''}`}
            onClick={() => setTheme('dark')}
          >
            <div className="swatch dark">
              <div className="swatch-bar" />
              <div className="swatch-body">
                <div className="swatch-line" />
                <div className="swatch-line short" />
              </div>
            </div>
            <div className="body">
              <div className="name">Dark</div>
              <div className="desc">Easier on the eyes for long coding sessions</div>
            </div>
            <div className="dot" />
          </button>
          <button
            type="button"
            className={`radio-card ${theme === 'light' ? 'on' : ''}`}
            onClick={() => setTheme('light')}
          >
            <div className="swatch light">
              <div className="swatch-bar" />
              <div className="swatch-body">
                <div className="swatch-line" />
                <div className="swatch-line short" />
              </div>
            </div>
            <div className="body">
              <div className="name">Light</div>
              <div className="desc">Crisp and bright for daytime use</div>
            </div>
            <div className="dot" />
          </button>
        </div>
      </section>
      <section className="section">
        <h3 className="section-title">
          Session view
          <Tip>
            What a session opens in on a desktop: the terminal (the CLI's own screen) or the stream
            (the conversation rendered as a chat). A phone always starts in the stream. The toggle in
            a session's header still switches that one session.
          </Tip>
        </h3>
        <div className="field-row">
          <div className="top">
            <span className="name">Default on desktop</span>
            <span className="control window-opts">
              {(['terminal', 'stream'] as const).map((v) => (
                <button
                  type="button"
                  key={v}
                  className={`window-opt${desktopView === v ? ' on' : ''}`}
                  onClick={() => setDesktopView(v)}
                >
                  {v === 'terminal' ? 'Terminal' : 'Stream'}
                </button>
              ))}
            </span>
          </div>
        </div>
      </section>
      <StreamFontSection />
    </>
  );
}

function StreamFontSection(): JSX.Element {
  const [v, setV] = useState<StreamFont>(readStreamFont);
  // only what this device has installed; the saved choice stays listed even if
  // its font went away, so it can be seen and changed
  const [fonts] = useState(() => {
    const ok = availableStreamFonts();
    const saved = STREAM_FONTS.find((f) => f.id === readStreamFont().font);
    return saved && !ok.includes(saved) ? STREAM_FONTS.filter((f) => ok.includes(f) || f === saved) : ok;
  });
  const set = (next: StreamFont): void => {
    const clean = { ...next, size: clampSize(next.size) };
    setV(clean);
    saveStreamFont(clean);
  };
  const css = STREAM_FONTS.find((f) => f.id === v.font)?.css || undefined;
  return (
    <section className="section">
      <h3 className="section-title">
        Stream text
        <Tip>
          The conversation text in Stream view — messages, tool cards, thinking. Saved per device, so a
          phone and a desktop can differ.
        </Tip>
      </h3>
      <div className="field-row">
        <div className="top">
          <span className="name">Font</span>
          <span className="control window-opts">
            {fonts.map((f) => (
              <button
                type="button"
                key={f.id}
                className={`window-opt${v.font === f.id ? ' on' : ''}`}
                style={f.css ? { fontFamily: f.css } : undefined}
                onClick={() => set({ ...v, font: f.id })}
              >
                {f.label}
              </button>
            ))}
          </span>
        </div>
      </div>
      <div className="field-row">
        <div className="top">
          <span className="name">Size</span>
          <span className="control window-opts">
            <button
              type="button"
              className="window-opt"
              disabled={v.size <= STREAM_SIZE.min}
              onClick={() => set({ ...v, size: v.size - 1 })}
            >
              A−
            </button>
            <span className="stream-font-size">{v.size}px</span>
            <button
              type="button"
              className="window-opt"
              disabled={v.size >= STREAM_SIZE.max}
              onClick={() => set({ ...v, size: v.size + 1 })}
            >
              A+
            </button>
            <button
              type="button"
              className={`window-opt${v.size === STREAM_SIZE.base ? ' on' : ''}`}
              onClick={() => set({ ...v, size: STREAM_SIZE.base })}
            >
              Default
            </button>
          </span>
        </div>
      </div>
      <div className="stream-font-preview" style={{ fontFamily: css, fontSize: `${v.size}px` }}>
        This is how a message reads in Stream view. 这是 Stream 视图里消息的样子。
        <code>pnpm test</code>
      </div>
    </section>
  );
}

/* ---------------------------- Providers ---------------------------- */

type ProvidersResult = Result<'provider.list'>;

function ProvidersPane({ rpc }: { rpc: Rpc }): JSX.Element {
  const [data, setData] = useState<ProvidersResult | null>(null);
  useEffect(() => {
    void rpc.request('provider.list', {}).then(setData);
  }, [rpc]);
  return (
    <>
      <h1 className="page-title">Providers</h1>
      <section className="section">
        <h3 className="section-title">
          CLI runtimes
          <Tip>
            Agent CLIs Ateam can drive. Any detected runtime can start a new
            session; Claude and Codex resume, wake and hand off (Codex is keyed
            to its own thread id after the first turn); OpenCode has no
            interactive resume yet.
          </Tip>
        </h3>
        {!data && <div className="muted">scanning PATH…</div>}
        {data?.providers.map((p) => (
          <div key={p.id} className="toggle-row">
            <div className="body">
              <div className="name">{p.label}</div>
              <div className="desc">
                <span className="mono">{p.binName}</span>{' '}
                <span className="muted">·</span>{' '}
                <span className="mono muted">{p.path ?? 'not in PATH'}</span>
                <br />
                {p.runtimeSupported
                  ? 'Runtime supported — Ateam spawns this CLI today.'
                  : 'Detection only — runtime adapter pending.'}
              </div>
            </div>
            <div className="right">
              <span className={`pill ${p.available ? 'good' : 'bad'}`}>
                {p.available ? 'available' : 'not found'}
              </span>
              <div className={`toggle-switch ${p.runtimeSupported && p.available ? 'on' : ''}`} />
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
