import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root for all user assets. `ATEAM_HOME` overrides (tests / portability). */
export function ateamHome(): string {
  return process.env.ATEAM_HOME ?? join(homedir(), '.ateam');
}

export function usersDir(): string {
  return join(ateamHome(), 'users');
}

export function systemDir(): string {
  return join(ateamHome(), 'system');
}
