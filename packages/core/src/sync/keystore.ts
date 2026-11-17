import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ateamHome } from '../paths';

/**
 * Where this device keeps the unlocked data key, so the passphrase is asked
 * once per device. macOS: the login Keychain via `security`. Elsewhere (and
 * when `ATEAM_SYNC_KEYSTORE=file`, which tests use): a 0600 file under the
 * Ateam home. The entry is per Ateam home, so the debug app (~/.ateam-debug)
 * and the release app never share or clobber one.
 */
const ACCOUNT = 'ateam';
const service = (): string =>
  `ateam-sync-${createHash('sha256').update(ateamHome()).digest('hex').slice(0, 12)}`;
const useKeychain = (): boolean =>
  process.platform === 'darwin' && process.env.ATEAM_SYNC_KEYSTORE !== 'file';
const keyFile = (): string => join(ateamHome(), 'sync', 'key');

export function loadDataKey(): Buffer | undefined {
  try {
    const b64 = useKeychain()
      ? execFileSync('security', ['find-generic-password', '-a', ACCOUNT, '-s', service(), '-w'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      : existsSync(keyFile())
        ? readFileSync(keyFile(), 'utf8').trim()
        : '';
    const key = Buffer.from(b64, 'base64');
    return key.length === 32 ? key : undefined;
  } catch {
    return undefined; // not stored (security exits 44)
  }
}

export function saveDataKey(key: Buffer): void {
  const b64 = key.toString('base64');
  if (useKeychain()) {
    // -U updates an existing item instead of failing
    execFileSync(
      'security',
      ['add-generic-password', '-a', ACCOUNT, '-s', service(), '-w', b64, '-U'],
      { stdio: 'ignore' },
    );
    return;
  }
  mkdirSync(join(ateamHome(), 'sync'), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile(), `${b64}\n`, { mode: 0o600 });
}

export function forgetDataKey(): void {
  try {
    if (useKeychain())
      execFileSync('security', ['delete-generic-password', '-a', ACCOUNT, '-s', service()], {
        stdio: 'ignore',
      });
    else rmSync(keyFile(), { force: true });
  } catch {
    /* nothing stored */
  }
}
