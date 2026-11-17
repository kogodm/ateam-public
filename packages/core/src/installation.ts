import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ateamHome } from './paths';

/**
 * This install's identity, created once in `~/.ateam/installation.json`.
 * Sent when registering with the relay so signing in again from the same
 * machine reuses its device instead of adding another one (docs/sync/design.md
 * §2). Not a secret: it only matters together with the account password.
 */
export function installationId(): string {
  const path = join(ateamHome(), 'installation.json');
  if (existsSync(path)) {
    try {
      const { id } = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown };
      if (typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id)) return id;
    } catch {
      /* unreadable — mint a new one below */
    }
  }
  const id = randomUUID();
  mkdirSync(ateamHome(), { recursive: true });
  writeFileSync(
    `${path}.tmp`,
    `${JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2)}\n`,
  );
  renameSync(`${path}.tmp`, path);
  return id;
}
