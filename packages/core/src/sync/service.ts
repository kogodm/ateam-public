import type { SyncDevice, SyncStatus } from '@ateam/contract';
import { DEFAULT_RELAY_BASE_URL, loadConfig, saveConfig } from '../config';
import { listHumans, upsertHuman } from '../humans';
import { ensureProjectMarker, recordProjectDir } from '../project-identity';
import { allTasks, backfillTaskProjectIds } from '../tasks';
import { BadPassphrase, type KeyEnvelope, newDataKey, unwrapDataKey, wrapDataKey } from './crypto';
import { syncPass } from './engine';
import { forgetDataKey, loadDataKey, saveDataKey } from './keystore';
import { RelayHttpError, type SyncApi, relaySyncApi } from './relay-http';

/**
 * Sync on this device: turning it on and off, the unlocked key, the schedule,
 * and what the Settings page shows. The pass itself is engine.ts.
 */

const INTERVAL_MS = 60_000;
const FIRST_PASS_DELAY_MS = 10_000;

const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** what a relay error means to the person looking at Settings */
function explain(e: unknown): string {
  if (e instanceof RelayHttpError) {
    if (e.status === 401)
      return 'This device is no longer signed in to the relay (signed out or removed) — sign in again';
    if (e.status === 404 && /unknown endpoint/.test(e.message))
      return 'This relay does not support sync yet (the server needs an upgrade)';
    if (e.status === 413) return `Sync storage is full: ${e.message}`;
    if (e.status === 429)
      return 'The relay is temporarily locked after too many failures — try again shortly';
    return `relay ${e.status}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export interface SyncServiceDeps {
  /** the relay's public HTTPS port as the tunnel learned it, if connected */
  clientPort?: () => number | undefined;
  /** tests inject an API; production talks HTTPS to the configured relay */
  api?: (ep: {
    baseUrl: string;
    deviceId: string;
    token: string;
    tlsFingerprint: string;
  }) => SyncApi;
  /** after this device is revoked — re-apply the tunnel so it stops dialing */
  onSignedOut?: () => void;
}

export class SyncService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private key: Buffer | undefined;
  private lastSyncAt?: string;
  private lastError?: string;
  private last?: { pushed: number; pulled: number; conflicts: number };

  constructor(private readonly deps: SyncServiceDeps = {}) {}

  /** at app start: resume the schedule when sync was left on */
  start(): void {
    if (!loadConfig().sync.enabled) return;
    this.key = loadDataKey();
    if (this.key) this.schedule();
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = undefined;
    this.first = undefined;
  }

  private endpoint(): { baseUrl: string; deviceId: string; token: string; tlsFingerprint: string } {
    const { remote } = loadConfig();
    if (!remote.deviceId || !remote.token)
      throw coded('not_signed_in', 'Sign in to a relay account first (Remote → Remote access)');
    const host = remote.url.replace(/^wss?:\/\//, '').replace(/[:/].*$/, '');
    const port = this.deps.clientPort?.() ?? Number(new URL(DEFAULT_RELAY_BASE_URL).port);
    return {
      baseUrl: `https://${host}:${port}`,
      deviceId: remote.deviceId,
      token: remote.token,
      tlsFingerprint: remote.tlsFingerprint,
    };
  }

  private api(): SyncApi {
    const ep = this.endpoint();
    return (this.deps.api ?? relaySyncApi)(ep);
  }

  status(): SyncStatus {
    const c = loadConfig();
    this.key ??= c.sync.enabled ? loadDataKey() : undefined;
    return {
      enabled: c.sync.enabled,
      signedIn: !!(c.remote.deviceId && c.remote.token),
      email: c.remote.email,
      deviceId: c.remote.deviceId,
      unlocked: !!this.key,
      syncing: !!this.running,
      ...(this.lastSyncAt ? { lastSyncAt: this.lastSyncAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.last
        ? {
            lastPushed: this.last.pushed,
            lastPulled: this.last.pulled,
            lastConflicts: this.last.conflicts,
          }
        : {}),
    };
  }

  /** Turn sync on (or unlock it on this device) with the account passphrase. */
  async enable(passphrase: string): Promise<SyncStatus> {
    const api = this.api();
    const me = await api.me().catch((e: unknown) => {
      throw coded('relay_error', explain(e));
    });
    const cfg = loadConfig();
    if (cfg.remote.accountId !== me.accountId || cfg.remote.email !== me.email)
      saveConfig({ ...cfg, remote: { ...cfg.remote, accountId: me.accountId, email: me.email } });

    const stored = await api.getKey();
    let key: Buffer;
    try {
      if (stored.version === 0) {
        const fresh = newDataKey();
        const put = await api.putKey(wrapDataKey(fresh, passphrase), 0);
        // another device set the key a moment ago: theirs is the account's key
        key = put.ok ? fresh : unwrapDataKey(put.envelope as KeyEnvelope, passphrase);
      } else {
        key = unwrapDataKey(stored.envelope as KeyEnvelope, passphrase);
      }
    } catch (e) {
      if (e instanceof BadPassphrase)
        throw coded(
          'bad_passphrase',
          'Wrong passphrase — this account already has one, set on another device',
        );
      throw e;
    }
    saveDataKey(key);
    this.key = key;
    const now = loadConfig();
    if (!now.sync.enabled) {
      saveConfig({ ...now, sync: { ...now.sync, enabled: true } });
      markKnownProjects();
    }
    this.lastError = undefined;
    this.schedule();
    await this.now();
    return this.status();
  }

  async disable(): Promise<SyncStatus> {
    this.shutdown();
    await this.running?.catch(() => {});
    forgetDataKey();
    this.key = undefined;
    const c = loadConfig();
    saveConfig({ ...c, sync: { ...c.sync, enabled: false } });
    return this.status();
  }

  /** Run a pass now (joins one already running). */
  async now(): Promise<SyncStatus> {
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = undefined;
      });
    }
    await this.running;
    return this.status();
  }

  private async pass(): Promise<void> {
    const c = loadConfig();
    if (!c.sync.enabled) return;
    this.key ??= loadDataKey();
    if (!this.key) {
      this.lastError = 'Enter the sync passphrase to unlock this device';
      return;
    }
    try {
      const api = this.api();
      let accountId = c.remote.accountId;
      if (!accountId) {
        const me = await api.me();
        accountId = me.accountId;
        saveConfig({ ...c, remote: { ...c.remote, accountId, email: me.email } });
      }
      const r = await syncPass({
        api,
        key: this.key,
        accountId,
        deviceId: c.remote.deviceId,
        deviceName: c.remote.name || 'device',
      });
      this.last = { pushed: r.pushed, pulled: r.pulled, conflicts: r.conflicts };
      this.lastSyncAt = new Date().toISOString();
      this.lastError =
        r.unreadable > 0
          ? `${r.unreadable} records could not be decrypted (another device may have reset the key)`
          : undefined;
    } catch (e) {
      this.lastError = explain(e);
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.first = setTimeout(() => void this.now(), FIRST_PASS_DELAY_MS);
    this.timer = setInterval(() => void this.now(), INTERVAL_MS);
  }

  async changePassphrase(current: string, next: string): Promise<void> {
    const api = this.api();
    const stored = await api.getKey();
    if (stored.version === 0) throw coded('not_enabled', 'This account has no sync passphrase yet');
    let key: Buffer;
    try {
      key = unwrapDataKey(stored.envelope as KeyEnvelope, current);
    } catch {
      throw coded('bad_passphrase', 'Current passphrase is wrong');
    }
    const put = await api.putKey(wrapDataKey(key, next), stored.version);
    if (!put.ok)
      throw coded(
        'conflict',
        'The passphrase was just changed on another device — refresh and try again',
      );
  }

  async devices(): Promise<SyncDevice[]> {
    try {
      return await this.api().devices();
    } catch (e) {
      throw coded('relay_error', explain(e));
    }
  }

  async createInvite(uses?: number, days?: number): Promise<{ code: string; expiresAt: string }> {
    try {
      return await this.api().createInvite(uses, days);
    } catch (e) {
      throw coded('relay_error', explain(e));
    }
  }

  async renameDevice(id: string, name: string): Promise<void> {
    await this.api().renameDevice(id, name);
    const c = loadConfig();
    if (id === c.remote.deviceId) saveConfig({ ...c, remote: { ...c.remote, name } });
  }

  async revokeDevice(id: string): Promise<void> {
    await this.api().revokeDevice(id);
    const c = loadConfig();
    if (id !== c.remote.deviceId) return;
    // this machine: its credentials are dead — sign out and stop syncing
    await this.disable();
    const after = loadConfig();
    saveConfig({
      ...after,
      remote: {
        ...after.remote,
        enabled: false,
        deviceId: '',
        token: '',
        accountId: '',
        email: '',
      },
    });
    this.deps.onSignedOut?.();
  }
}

/**
 * Turning sync on is when Ateam may write `.ateam/project.json` into the
 * user's projects (docs/sync/design.md §1): give every folder this device
 * already worked in its marker, and point tasks and participations at it.
 */
function markKnownProjects(): void {
  const dirs = new Set<string>();
  for (const h of listHumans()) for (const p of h.projects) if (p.dir) dirs.add(p.dir);
  for (const t of allTasks()) if (t.project) dirs.add(t.project);
  const idFor = new Map<string, string>();
  for (const dir of dirs) {
    try {
      const r = ensureProjectMarker(dir);
      if (r.kind === 'found' || r.kind === 'created') {
        recordProjectDir(r.marker, r.root);
        idFor.set(dir, r.marker.id);
      }
    } catch {
      /* a folder that is gone or unwritable just stays unmarked */
    }
  }
  for (const h of listHumans()) {
    if (!h.projects.some((p) => !p.projectId && idFor.has(p.dir))) continue;
    upsertHuman({
      ...h,
      projects: h.projects.map((p) =>
        p.projectId || !idFor.has(p.dir) ? p : { ...p, projectId: idFor.get(p.dir) },
      ),
    });
  }
  backfillTaskProjectIds();
}
