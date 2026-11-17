import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * End-to-end encryption for sync (docs/sync/design.md §5).
 *
 * One random 256-bit DATA KEY per account encrypts everything. It never
 * leaves a device in the clear: the relay stores it wrapped by a key derived
 * from the user's sync passphrase (scrypt), and each device keeps its
 * unwrapped copy in its own keystore. Record keys and blob ids are HMACs of
 * the data key, so the server can dedupe and order without learning names.
 */

export interface KeyEnvelope {
  v: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const b64u = (b: Buffer): string => b.toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

export class BadPassphrase extends Error {
  readonly code = 'bad_passphrase';
  constructor() {
    super('bad passphrase');
  }
}

export const newDataKey = (): Buffer => randomBytes(32);

function wrappingKey(passphrase: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(passphrase.normalize('NFC'), salt, 32, { N: n, r, p, maxmem: 256 * n * r });
}

export function wrapDataKey(dataKey: Buffer, passphrase: string): KeyEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = wrappingKey(passphrase, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([c.update(dataKey), c.final()]);
  return {
    v: 1,
    kdf: 'scrypt',
    ...SCRYPT,
    salt: b64u(salt),
    iv: b64u(iv),
    tag: b64u(c.getAuthTag()),
    ct: b64u(ct),
  };
}

export function unwrapDataKey(env: KeyEnvelope, passphrase: string): Buffer {
  if (env?.v !== 1 || env.kdf !== 'scrypt') throw new Error('unknown key envelope');
  const kek = wrappingKey(passphrase, fromB64u(env.salt), env.N, env.r, env.p);
  try {
    const d = createDecipheriv('aes-256-gcm', kek, fromB64u(env.iv));
    d.setAuthTag(fromB64u(env.tag));
    const key = Buffer.concat([d.update(fromB64u(env.ct)), d.final()]);
    if (key.length !== 32) throw new BadPassphrase();
    return key;
  } catch {
    throw new BadPassphrase();
  }
}

/** `v1.<iv>.<tag>.<ct>` — a record's `data` on the wire */
export function encryptString(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(ct)}`;
}

export function decryptString(key: Buffer, data: string): string {
  const [v, iv, tag, ct] = data.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', key, fromB64u(iv));
  d.setAuthTag(fromB64u(tag));
  return Buffer.concat([d.update(fromB64u(ct)), d.final()]).toString('utf8');
}

/** blob bytes: iv(12) | tag(16) | ciphertext */
export function encryptBytes(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decryptBytes(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < 28) throw new Error('bad blob');
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

/** the server-side key of a record: opaque, stable per (type, local id) */
export function recordKey(key: Buffer, type: string, localId: string): string {
  return b64u(createHmac('sha256', key).update(`${type}:${localId}`).digest());
}

/** content-addressed blob id the server cannot link to the content */
export function blobId(key: Buffer, content: Buffer): string {
  return createHmac('sha256', key).update('blob:').update(content).digest('hex');
}

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
