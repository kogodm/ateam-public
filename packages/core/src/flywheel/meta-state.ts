import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ateamHome } from '../paths';

/** Persisted Meta-Agent bookkeeping so auto-evolution is idempotent. */
export interface MetaState {
  /** claudeSessionId -> transcript turn count at last reflect */
  reflectLen: Record<string, number>;
  /** `${humanId}|${domain}` -> experience count at last distillation */
  distilled: Record<string, number>;
  lastDecayAt?: string;
}

function file(): string {
  return join(ateamHome(), 'meta-state.json');
}

export function loadMetaState(): MetaState {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8')) as Partial<MetaState>;
    return { reflectLen: j.reflectLen ?? {}, distilled: j.distilled ?? {}, lastDecayAt: j.lastDecayAt };
  } catch {
    return { reflectLen: {}, distilled: {} };
  }
}

export function saveMetaState(s: MetaState): void {
  mkdirSync(ateamHome(), { recursive: true });
  writeFileSync(file(), JSON.stringify(s, null, 2));
}
