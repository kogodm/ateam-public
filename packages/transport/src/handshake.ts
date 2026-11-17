import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Sidecar/daemon writes this; TUI/CLI/Tauri read it to find the local server. */
export interface Handshake {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
}

export function handshakePath(): string {
  const dir = process.env.ATEAM_RUNTIME_DIR ?? tmpdir();
  return join(dir, 'ateam-handshake.json');
}

export function writeHandshake(h: Handshake): void {
  writeFileSync(handshakePath(), JSON.stringify(h), { mode: 0o600 });
}

export function readHandshake(): Handshake {
  return JSON.parse(readFileSync(handshakePath(), 'utf8')) as Handshake;
}
