import type { SyncDevice, SyncStatus } from '@ateam/contract';
import { useCallback, useEffect, useState } from 'react';
import { FoxWait } from './FoxWait';
import { Tip } from './Tip';
import type { Rpc } from './rpc';

const POLL_MS = 5000;
const MIN_PASS = 8;

/** Error text for the UI. `badPass` replaces the message when the core says
 *  the passphrase was wrong (code 'bad_passphrase'). */
function errText(e: unknown, badPass?: string): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (badPass && code === 'bad_passphrase') return badPass;
  return e instanceof Error ? e.message : String(e);
}

/** ISO time → just now / 5m ago / 3h ago / 2d ago / Sep 3 */
function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** A labelled password input inside a field card (the app's input style). */
function PassRow({
  label,
  value,
  onChange,
  onEnter,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  placeholder?: string;
}): JSX.Element {
  return (
    <label className="top sync-pass">
      <span className="name">{label}</span>
      <span className="control">
        <input
          type="password"
          value={value}
          autoComplete="new-password"
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEnter?.();
          }}
        />
      </span>
    </label>
  );
}

/**
 * Settings → Sync: status of cross-device sync (docs/sync/client.md), the
 * passphrase to turn it on, and the account's devices. Every RPC failure is
 * shown as text — the page must survive a core without the sync.* handlers.
 */
export function SyncPane({
  rpc,
  onOpenRemote,
  embedded = false,
}: {
  rpc: Rpc;
  /** switch Settings to the page holding relay access settings */
  onOpenRemote: () => void;
  /** render inside the Remote settings page instead of as a top-level page */
  embedded?: boolean;
}): JSX.Element {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [statusErr, setStatusErr] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await rpc.request('sync.status', {}));
      setStatusErr('');
    } catch (e) {
      setStatusErr(errText(e));
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <>
      {embedded ? <h2 className="section-title">Sync</h2> : <h1 className="page-title">Sync</h1>}
      <StatusSection
        rpc={rpc}
        status={status}
        statusErr={statusErr}
        setStatus={setStatus}
        onOpenRemote={onOpenRemote}
      />
      {status?.signedIn && !status.enabled && <EnableSection rpc={rpc} setStatus={setStatus} />}
      {status?.signedIn && status.enabled && (
        <EnabledSection rpc={rpc} status={status} setStatus={setStatus} />
      )}
      {status?.signedIn && <DevicesSection rpc={rpc} onChanged={refresh} />}
    </>
  );
}

/* ------------------------------ status ------------------------------ */

function StatusSection({
  rpc,
  status,
  statusErr,
  setStatus,
  onOpenRemote,
}: {
  rpc: Rpc;
  status: SyncStatus | null;
  statusErr: string;
  setStatus: (s: SyncStatus) => void;
  onOpenRemote: () => void;
}): JSX.Element {
  const [running, setRunning] = useState(false);
  const [nowErr, setNowErr] = useState('');

  const syncNow = async (): Promise<void> => {
    setRunning(true);
    setNowErr('');
    try {
      setStatus(await rpc.request('sync.now', {}));
    } catch (e) {
      setNowErr(errText(e));
    } finally {
      setRunning(false);
    }
  };

  const syncing = running || !!status?.syncing;
  const counts = status
    ? [
        status.lastPushed !== undefined ? `${status.lastPushed} sent` : '',
        status.lastPulled !== undefined ? `${status.lastPulled} received` : '',
        status.lastConflicts ? `${status.lastConflicts} conflict copies` : '',
      ].filter(Boolean)
    : [];

  return (
    <section className="section">
      <h3 className="section-title">
        Status
        <Tip>
          Syncs Humans, projects, tasks, knowledge files and prompts between the devices signed in
          to the same relay account. Everything is encrypted on this device with your sync
          passphrase before upload — the relay cannot read it. Runs every 60 seconds once enabled.
        </Tip>
      </h3>
      {statusErr && <em className="field-flag">Could not read sync status: {statusErr}</em>}
      {!status && !statusErr && (
        <div className="field-row sync-wait">
          <FoxWait size={16} />
        </div>
      )}
      {status && !status.signedIn && (
        <div className="field-row">
          <div className="top">
            <span className="name">Not signed in</span>
          </div>
          <div className="desc">
            Sync needs a relay account. Sign in under{' '}
            <RemoteAccessSettingsLink onOpenRemote={onOpenRemote} />.
          </div>
        </div>
      )}
      {status?.signedIn && (
        <div className="field-row">
          <div className="top">
            <span className="name sync-account">
              {status.email || '(no email)'}
              <span className={`pill ${status.enabled ? 'good' : ''}`}>
                {status.enabled ? 'On' : 'Off'}
              </span>
            </span>
            {status.enabled && (
              <span className="control">
                <button
                  type="button"
                  className="threshold-save sync-btn"
                  disabled={syncing || !status.unlocked}
                  onClick={() => void syncNow()}
                >
                  {syncing && <FoxWait size={16} />}
                  {syncing ? 'Syncing' : 'Sync now'}
                </button>
              </span>
            )}
          </div>
          {status.enabled && (
            <div className="desc">
              {status.lastSyncAt ? `Last synced ${ago(status.lastSyncAt)}` : 'Not synced yet'}
              {counts.length > 0 && ` · ${counts.join(' · ')}`}
            </div>
          )}
          {status.lastError && <em className="field-flag">{status.lastError}</em>}
          {nowErr && <em className="field-flag">{nowErr}</em>}
        </div>
      )}
    </section>
  );
}

export function RemoteAccessSettingsLink({
  onOpenRemote,
}: {
  onOpenRemote: () => void;
}): JSX.Element {
  return (
    <button type="button" className="sync-link" onClick={onOpenRemote}>
      Remote → Remote access
    </button>
  );
}

/* ------------------------------ turn on ------------------------------ */

function EnableSection({
  rpc,
  setStatus,
}: {
  rpc: Rpc;
  setStatus: (s: SyncStatus) => void;
}): JSX.Element {
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const tooShort = pass.length > 0 && pass.length < MIN_PASS;
  const mismatch = confirm.length > 0 && pass !== confirm;
  const ok = pass.length >= MIN_PASS && pass === confirm && !busy;

  const enable = async (): Promise<void> => {
    if (!ok) return;
    setBusy(true);
    setErr('');
    try {
      const s = await rpc.request('sync.enable', { passphrase: pass });
      setPass('');
      setConfirm('');
      setStatus(s);
    } catch (e) {
      setErr(errText(e, 'Wrong passphrase — this account already has one, set on another device'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section">
      <h3 className="section-title">
        Turn on sync
        <Tip>
          The first device's passphrase encrypts this account's synced data; every other device must
          enter the same one to turn sync on. The passphrase is never uploaded.
        </Tip>
      </h3>
      <em className="field-flag">
        ⚠ A lost passphrase cannot be recovered — synced data becomes unreadable (local data is
        unaffected). Other devices need the same passphrase.
      </em>
      <div className="field-row">
        <PassRow
          label="Sync passphrase"
          value={pass}
          onChange={setPass}
          onEnter={() => void enable()}
          placeholder={`At least ${MIN_PASS} characters`}
        />
        <PassRow
          label="Confirm passphrase"
          value={confirm}
          onChange={setConfirm}
          onEnter={() => void enable()}
        />
        <div className="top sync-actions">
          <span className="name" />
          <span className="control">
            <button
              type="button"
              className="threshold-save sync-btn"
              disabled={!ok}
              onClick={() => void enable()}
            >
              {busy && <FoxWait size={16} />}
              Turn on
            </button>
          </span>
        </div>
        {tooShort && <em className="field-flag">At least {MIN_PASS} characters</em>}
        {mismatch && <em className="field-flag">The two entries do not match</em>}
        {err && <em className="field-flag">{err}</em>}
      </div>
    </section>
  );
}

/* ------------------------------ turned on ------------------------------ */

function EnabledSection({
  rpc,
  status,
  setStatus,
}: {
  rpc: Rpc;
  status: SyncStatus;
  setStatus: (s: SyncStatus) => void;
}): JSX.Element {
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [unlockPass, setUnlockPass] = useState('');

  const disable = async (): Promise<void> => {
    setBusy(true);
    setErr('');
    try {
      setStatus(await rpc.request('sync.disable', {}));
      setConfirmOff(false);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  // enabled but the key is not on this device (e.g. Keychain wiped): the same
  // passphrase unlocks it again
  const unlock = async (): Promise<void> => {
    if (unlockPass.length < MIN_PASS || busy) return;
    setBusy(true);
    setErr('');
    try {
      setStatus(await rpc.request('sync.enable', { passphrase: unlockPass }));
      setUnlockPass('');
    } catch (e) {
      setErr(errText(e, 'Wrong passphrase'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section">
      <h3 className="section-title">Passphrase</h3>
      {!status.unlocked && (
        <div className="field-row">
          <PassRow
            label="Enter the sync passphrase to unlock"
            value={unlockPass}
            onChange={setUnlockPass}
            onEnter={() => void unlock()}
          />
          <div className="top sync-actions">
            <span className="name" />
            <span className="control">
              <button
                type="button"
                className="threshold-save sync-btn"
                disabled={unlockPass.length < MIN_PASS || busy}
                onClick={() => void unlock()}
              >
                Unlock
              </button>
            </span>
          </div>
        </div>
      )}
      <div className="field-row">
        <div className="top">
          <span className="name">
            Turn off sync
            <Tip>
              This device stops syncing and forgets its unlocked key. Local data and the server copy
              both stay; the same passphrase turns it back on.
            </Tip>
          </span>
          <span className="control">
            {confirmOff ? (
              <>
                <span className="sync-confirm">Turn off sync?</span>
                <button
                  type="button"
                  className="threshold-save danger sync-btn"
                  disabled={busy}
                  onClick={() => void disable()}
                >
                  {busy && <FoxWait size={16} />}
                  Turn off
                </button>
                <button
                  type="button"
                  className="threshold-save"
                  onClick={() => setConfirmOff(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="threshold-save" onClick={() => setConfirmOff(true)}>
                Turn off sync
              </button>
            )}
          </span>
        </div>
        {err && <em className="field-flag">{err}</em>}
      </div>
      {status.unlocked && <ChangePassphrase rpc={rpc} />}
    </section>
  );
}

function ChangePassphrase({ rpc }: { rpc: Rpc }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null);

  const mismatch = confirm.length > 0 && next !== confirm;
  const ok = current.length > 0 && next.length >= MIN_PASS && next === confirm && !busy;

  const submit = async (): Promise<void> => {
    if (!ok) return;
    setBusy(true);
    setNote(null);
    try {
      await rpc.request('sync.changePassphrase', { current, next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setNote({
        text: 'Passphrase changed. Other devices use the new one next time they unlock.',
        warn: false,
      });
    } catch (e) {
      setNote({ text: errText(e, 'Current passphrase is wrong'), warn: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field-row prompt-row">
      <div className="prompt-head">
        <button
          type="button"
          className="prompt-toggle name"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Change passphrase
        </button>
        <span className="prompt-spacer" />
        <button
          type="button"
          className="prompt-toggle prompt-chev"
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={() => setOpen(!open)}
        >
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open && (
        <div className="prompt-editor">
          <PassRow label="Current passphrase" value={current} onChange={setCurrent} />
          <PassRow
            label="New passphrase"
            value={next}
            onChange={setNext}
            placeholder={`At least ${MIN_PASS} characters`}
          />
          <PassRow
            label="Confirm new passphrase"
            value={confirm}
            onChange={setConfirm}
            onEnter={() => void submit()}
          />
          <div className="top sync-actions">
            <span className="name" />
            <span className="control">
              <button
                type="button"
                className="threshold-save sync-btn"
                disabled={!ok}
                onClick={() => void submit()}
              >
                {busy && <FoxWait size={16} />}
                Change
              </button>
            </span>
          </div>
          {next.length > 0 && next.length < MIN_PASS && (
            <em className="field-flag">New passphrase needs at least {MIN_PASS} characters</em>
          )}
          {mismatch && <em className="field-flag">The two entries do not match</em>}
          {note && <em className={`field-flag${note.warn ? '' : ' info'}`}>{note.text}</em>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ devices ------------------------------ */

function DevicesSection({
  rpc,
  onChanged,
}: {
  rpc: Rpc;
  /** re-read sync status (revoking this device signs it out) */
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [devices, setDevices] = useState<SyncDevice[] | null>(null);
  const [loadErr, setLoadErr] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await rpc.request('sync.devices', {});
      setDevices(r.devices);
      setLoadErr('');
    } catch (e) {
      setLoadErr(errText(e));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterAction = async (): Promise<void> => {
    await load();
    await onChanged();
  };

  return (
    <section className="section">
      <h3 className="section-title">
        Devices
        <Tip>
          Every device signed in to this account. Removing one cuts its remote access and sync; it
          has to sign in again to come back.
        </Tip>
      </h3>
      {loadErr && <em className="field-flag">Could not load devices: {loadErr}</em>}
      {!devices && !loadErr && (
        <div className="field-row sync-wait">
          <FoxWait size={16} />
        </div>
      )}
      {devices?.length === 0 && <div className="muted small">No devices</div>}
      {devices?.map((d) => (
        <DeviceRow key={d.id} rpc={rpc} device={d} onChanged={afterAction} />
      ))}
    </section>
  );
}

function DeviceRow({
  rpc,
  device: d,
  onChanged,
}: {
  rpc: Rpc;
  device: SyncDevice;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [mode, setMode] = useState<'view' | 'rename' | 'revoke'>('view');
  const [name, setName] = useState(d.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = async (call: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setErr('');
    try {
      await call();
      setMode('view');
      await onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const trimmed = name.trim();
  const rename = (): void => {
    if (!trimmed || trimmed === d.name || busy) return;
    void run(() => rpc.request('sync.renameDevice', { id: d.id, name: trimmed }));
  };

  return (
    <div className="field-row">
      <div className="top">
        <span className="name sync-device">
          <span
            className={`sync-dot${d.online ? ' on' : ''}`}
            title={d.online ? 'Online' : 'Offline'}
          />
          {mode === 'rename' ? (
            <span className="control">
              <input
                type="text"
                value={name}
                spellCheck={false}
                // biome-ignore lint/a11y/noAutofocus: the field appears because the user clicked Rename
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') rename();
                  if (e.key === 'Escape') setMode('view');
                }}
              />
            </span>
          ) : (
            <span className="sync-device-name">{d.name || d.id}</span>
          )}
          {d.current && <span className="prompt-state">This device</span>}
        </span>
        <span className="control">
          {mode === 'rename' && (
            <>
              <button
                type="button"
                className="threshold-save"
                disabled={!trimmed || trimmed === d.name || busy}
                onClick={rename}
              >
                Save
              </button>
              <button type="button" className="threshold-save" onClick={() => setMode('view')}>
                Cancel
              </button>
            </>
          )}
          {mode === 'revoke' && (
            <>
              <span className="sync-confirm">
                {d.current ? 'Remove this device? It will be signed out' : 'Remove this device?'}
              </span>
              <button
                type="button"
                className="threshold-save danger sync-btn"
                disabled={busy}
                onClick={() => void run(() => rpc.request('sync.revokeDevice', { id: d.id }))}
              >
                {busy && <FoxWait size={16} />}
                Remove
              </button>
              <button type="button" className="threshold-save" onClick={() => setMode('view')}>
                Cancel
              </button>
            </>
          )}
          {mode === 'view' && (
            <>
              <button
                type="button"
                className="threshold-save"
                onClick={() => {
                  setName(d.name);
                  setErr('');
                  setMode('rename');
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="threshold-save"
                onClick={() => {
                  setErr('');
                  setMode('revoke');
                }}
              >
                Remove
              </button>
            </>
          )}
        </span>
      </div>
      <div className="desc">
        {d.online ? 'Online' : d.lastSeenAt ? `Last seen ${ago(d.lastSeenAt)}` : 'Never connected'}
      </div>
      {err && <em className="field-flag">{err}</em>}
    </div>
  );
}
