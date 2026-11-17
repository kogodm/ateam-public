import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Invite codes for account creation (signup mode 'invite', the default).
 * Only a code's sha256 is stored; the plaintext is shown once when created.
 * Existing accounts never need one — only creating a new account does.
 */
interface Invite {
  sha256: string;
  createdBy: string;
  createdAt: string;
  expiresAt: number;
  usesLeft: number;
  usedBy: string[];
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** case- and dash-insensitive, so a code read aloud or retyped still works */
const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export class InviteStore {
  private list: Invite[] = [];

  constructor(private readonly path: string) {
    try {
      if (existsSync(path)) this.list = JSON.parse(readFileSync(path, 'utf8')) as Invite[];
    } catch {
      this.list = [];
    }
    if (!Array.isArray(this.list)) this.list = [];
  }

  private save(): void {
    const now = Date.now();
    this.list = this.list.filter((i) => i.usesLeft > 0 && i.expiresAt > now);
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.list, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** A new code, returned in plaintext once: `ABCD-EFGH-JKLM`. */
  create(createdBy: string, uses = 1, days = 7): { code: string; expiresAt: string } {
    const bytes = randomBytes(12);
    const raw = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
    const expiresAt = Date.now() + Math.min(Math.max(days, 1), 90) * 86_400_000;
    this.list.push({
      sha256: sha(normalize(code)),
      createdBy,
      createdAt: new Date().toISOString(),
      expiresAt,
      usesLeft: Math.min(Math.max(Math.floor(uses), 1), 100),
      usedBy: [],
    });
    this.save();
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Is this code currently usable? Does not spend it. */
  valid(code: string | undefined): boolean {
    if (!code) return false;
    const h = sha(normalize(code));
    return this.list.some((i) => i.sha256 === h && i.usesLeft > 0 && i.expiresAt > Date.now());
  }

  /** Spend one use, recording who used it. False when the code is not usable. */
  consume(code: string | undefined, email: string): boolean {
    if (!code) return false;
    const h = sha(normalize(code));
    const i = this.list.find((x) => x.sha256 === h && x.usesLeft > 0 && x.expiresAt > Date.now());
    if (!i) return false;
    i.usesLeft -= 1;
    i.usedBy = [...i.usedBy, email.trim().toLowerCase()];
    this.save();
    return true;
  }

  activeCount(): number {
    return this.list.filter((i) => i.usesLeft > 0 && i.expiresAt > Date.now()).length;
  }
}
