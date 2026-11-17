import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IS_WINDOWS, whichSync, whichViaSystem } from '../platform';

/** Resolve the `claude` executable. Lookup order:
 *   1. $ATEAM_CLAUDE_BIN (explicit override)
 *   2. well-known per-user install paths
 *      • macOS / Linux: ~/.local/bin/claude
 *      • Windows: %LOCALAPPDATA%/Programs/claude/claude.exe (npm-style),
 *                 plus a PATHEXT-aware lookup
 *   3. cross-platform whichSync
 *   4. system `which`/`where` as last-resort
 *   5. literal 'claude' (let the OS resolve at spawn time) */
export function resolveClaudeBin(): string {
  if (process.env.ATEAM_CLAUDE_BIN) return process.env.ATEAM_CLAUDE_BIN;
  const candidates: string[] = [];
  if (IS_WINDOWS) {
    const lad = process.env.LOCALAPPDATA;
    if (lad) {
      candidates.push(join(lad, 'Programs', 'claude', 'claude.exe'));
      candidates.push(join(lad, 'Programs', 'claude', 'claude.cmd'));
    }
    candidates.push(join(homedir(), '.local', 'bin', 'claude.exe'));
  } else {
    candidates.push(join(homedir(), '.local', 'bin', 'claude'));
    candidates.push('/usr/local/bin/claude');
    candidates.push('/opt/homebrew/bin/claude');
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return whichSync('claude') ?? whichViaSystem('claude') ?? 'claude';
}
