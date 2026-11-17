import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Accounts + devices, one JSON file, atomic writes. Sessions are in-memory
 *  (a relay restart logs everyone out — fine). Passwords: scrypt hash+salt.
 *  Device tokens: sha256 only (the desktop holds the secret). */
export interface UserRec {
  /** stable identity every synced record belongs to; email stays the login */
  accountId: string;
  passHash: string;
  passSalt: string;
  createdAt: string;
}
export interface DeviceRec {
  owner: string; // user email
  name: string;
  tokenSha256: string;
  createdAt: string;
  lastSeenAt?: string;
  /** the desktop's ~/.ateam/installation.json id — signing in again from the
   *  same install reuses this record instead of minting another device */
  installationId?: string;
}
export interface StoreData {
  users: Record<string, UserRec>;
  devices: Record<string, DeviceRec>;
}

export class Store {
  private data: StoreData;
  constructor(private readonly path: string) {
    this.data = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as StoreData)
      : { users: {}, devices: {} };
    this.data.users ??= {};
    this.data.devices ??= {};
    // accounts created before sync have no accountId — assign one, once
    const missing = Object.entries(this.data.users).filter(([, u]) => !u.accountId);
    if (missing.length) {
      this.data.users = {
        ...this.data.users,
        ...Object.fromEntries(missing.map(([k, u]) => [k, { ...u, accountId: randomUUID() }])),
      };
      this.save();
    }
  }

  private save(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  userCount(): number {
    return Object.keys(this.data.users).length;
  }

  hasUser(email: string): boolean {
    return !!this.data.users[email.trim().toLowerCase()];
  }

  addUser(email: string, password: string): void {
    const key = email.trim().toLowerCase();
    if (this.data.users[key]) throw new Error('account already exists');
    const passSalt = randomBytes(16).toString('hex');
    const passHash = scryptSync(password, passSalt, 32).toString('hex');
    this.data.users = {
      ...this.data.users,
      [key]: { accountId: randomUUID(), passHash, passSalt, createdAt: new Date().toISOString() },
    };
    this.save();
  }

  accountIdOf(email: string): string | undefined {
    return this.data.users[email.trim().toLowerCase()]?.accountId;
  }

  verifyUser(email: string, password: string): boolean {
    const u = this.data.users[email.trim().toLowerCase()];
    if (!u || !password) return false;
    const want = Buffer.from(u.passHash, 'hex');
    const got = scryptSync(password, u.passSalt, want.length);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** create a device under `owner` — or, for an installation this owner
   *  already registered, reuse that device with a fresh token (the old token
   *  stops working). Returns the plaintext token ONCE. */
  addDevice(
    owner: string,
    name: string,
    installationId?: string,
  ): { id: string; token: string; reused: boolean } {
    const ownerKey = owner.trim().toLowerCase();
    const inst = cleanInstallationId(installationId);
    const prior = inst
      ? Object.entries(this.data.devices).find(
          ([, d]) => d.owner === ownerKey && d.installationId === inst,
        )
      : undefined;
    const id = prior?.[0] ?? randomBytes(6).toString('hex');
    const token = randomBytes(24).toString('base64url');
    this.data.devices = {
      ...this.data.devices,
      [id]: {
        ...(prior?.[1] ?? { createdAt: new Date().toISOString() }),
        owner: ownerKey,
        name: name.trim().slice(0, 60) || 'device',
        tokenSha256: sha256hex(token),
        ...(inst ? { installationId: inst } : {}),
      },
    };
    this.save();
    return { id, token, reused: !!prior };
  }

  renameDevice(id: string, owner: string, name: string): boolean {
    const d = this.data.devices[id];
    const clean = name.trim().slice(0, 60);
    if (!d || d.owner !== owner.trim().toLowerCase() || !clean) return false;
    this.data.devices = { ...this.data.devices, [id]: { ...d, name: clean } };
    this.save();
    return true;
  }

  device(id: string): DeviceRec | undefined {
    return this.data.devices[id];
  }

  devicesOf(owner: string): { id: string; rec: DeviceRec }[] {
    const key = owner.trim().toLowerCase();
    return Object.entries(this.data.devices)
      .filter(([, d]) => d.owner === key)
      .map(([id, rec]) => ({ id, rec }));
  }

  verifyDeviceToken(id: string, token: string): boolean {
    const d = this.data.devices[id];
    if (!d || !token) return false;
    const want = Buffer.from(d.tokenSha256, 'hex');
    const got = Buffer.from(sha256hex(token), 'hex');
    return want.length === got.length && timingSafeEqual(want, got);
  }

  touchDevice(id: string): void {
    const d = this.data.devices[id];
    if (!d) return;
    this.data.devices = {
      ...this.data.devices,
      [id]: { ...d, lastSeenAt: new Date().toISOString() },
    };
    this.save();
  }

  removeDevice(id: string, owner: string): boolean {
    const d = this.data.devices[id];
    if (!d || d.owner !== owner.trim().toLowerCase()) return false;
    const { [id]: _gone, ...rest } = this.data.devices;
    this.data.devices = rest;
    this.save();
    return true;
  }

  /** legacy v1 config.devices (ownerless) → claim under an account */
  claimDevice(id: string, dev: { tokenSha256: string; name?: string }, owner: string): void {
    if (this.data.devices[id]) return;
    this.data.devices = {
      ...this.data.devices,
      [id]: {
        owner: owner.trim().toLowerCase(),
        name: dev.name ?? id,
        tokenSha256: dev.tokenSha256,
        createdAt: new Date().toISOString(),
      },
    };
    this.save();
  }
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** installation ids are desktop-generated uuids; anything else is ignored */
function cleanInstallationId(v: unknown): string | undefined {
  return typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : undefined;
}
