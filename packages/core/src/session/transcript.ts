import type { Turn } from '@ateam/contract';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping needs ESC.
const ANSI = /\[[0-9;?]*[ -/]*[@-~]|\][^]*/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/**
 * Rolling transcript of a PTY session.
 *
 * M1: keeps the raw PTY stream and exposes an ANSI-stripped text snapshot;
 * `toTurns` returns that snapshot as a single placeholder turn so the
 * programmatic interface is exercised end-to-end.
 *
 * M2 (flywheel): structured turns will be parsed from Claude Code's on-disk
 * session JSONL rather than scraped from the interactive PTY — that is the
 * flywheel's real, lossless input. Kept behind this same interface.
 */
export class Transcript {
  private raw = '';
  private readonly max = 200_000;

  push(chunk: string): void {
    this.raw += chunk;
    if (this.raw.length > this.max) this.raw = this.raw.slice(-this.max);
  }

  /** the raw PTY byte stream (last ~200KB) — replayed into a freshly
   *  attached terminal so a new client (phone / LAN) is not blank */
  rawTail(maxChars = 120_000): string {
    return this.raw.length > maxChars ? this.raw.slice(-maxChars) : this.raw;
  }

  text(): string {
    return stripAnsi(this.raw);
  }

  toTurns(sessionId: string, since = 0): Turn[] {
    if (since > 0) return [];
    const t = this.text().trim();
    if (!t) return [];
    return [{ seq: 0, sessionId, role: 'system', text: t, at: new Date().toISOString() }];
  }
}
