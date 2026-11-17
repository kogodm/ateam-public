import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { stripClaudeProcessMarkers } from './session/claude-env';

/**
 * Tiny per-OS helpers so the rest of core can stay agnostic. The product
 * was macOS-only until provider/Windows work landed; gating on these flags
 * keeps Darwin code paths inert on Win32 and vice versa.
 */

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

/** Extensions to probe when looking up a bin name on Windows (PATHEXT). On
 *  POSIX this is just [''] so we look up the name as given. */
function pathExts(): string[] {
  if (!IS_WINDOWS) return [''];
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  // PATHEXT entries already start with '.'; also include '' so an exact
  // 'foo' name (no extension) is tried first in case the user pointed at a
  // suffixless shim.
  return ['', ...raw.split(';').map((s) => s.trim()).filter(Boolean)];
}

/** Cross-platform PATH lookup. Mirrors `which` on POSIX and `where` on
 *  Windows but does the lookup ourselves so it works in any shell
 *  environment (the bundled sidecar process may not have a `which`/`where`
 *  in scope under launchd / Windows services). */
export function whichSync(bin: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = pathExts();
  for (const d of dirs) {
    for (const e of exts) {
      const full = join(d, bin + e);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

let shellEnvCache: Record<string, string> | undefined;

/**
 * The user's LOGIN-shell environment (macOS/Linux). A GUI app launched from
 * Launchpad/Finder inherits launchd's minimal env — none of the exports in
 * ~/.zshrc / ~/.zprofile exist (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
 * proxy vars, PATH additions…), so `claude` works in the user's terminal but
 * dies when we spawn it. Run `$SHELL -lc env` ONCE (non-interactive login
 * shell, 5s timeout) and cache the result. Returns {} on Windows (GUI apps
 * get the user's registry env there) and on any failure.
 */
export function loginShellEnv(): Record<string, string> {
  if (shellEnvCache) return shellEnvCache;
  if (IS_WINDOWS) {
    shellEnvCache = {};
    return shellEnvCache;
  }
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-lc', 'command env'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).toString();
    const env: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    // The shell we just ran is OUR child, so anything claude exported into
    // this process comes straight back out of `env` — harvesting the login
    // shell must not be a way for those markers to re-enter. Stripped at the
    // source so every caller is safe, not just the PTY spawn.
    shellEnvCache = stripClaudeProcessMarkers(env);
  } catch {
    shellEnvCache = {};
  }
  return shellEnvCache;
}

/** PATH that unions the login shell's PATH with the current process one
 *  (shell entries first, deduped) — so PTY children can find user-installed
 *  tools (claude, npx, brew bins) even under a launchd-spawned GUI app. */
export function mergedPath(): string {
  const shellPath = loginShellEnv().PATH ?? '';
  const procPath = process.env.PATH ?? '';
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const p of [...shellPath.split(delimiter), ...procPath.split(delimiter)]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      parts.push(p);
    }
  }
  return parts.join(delimiter);
}

/** Single-shot result of running `which`/`where` as a final fallback. Some
 *  exotic PATH situations (aliases, shell-functions, env shimming) won't
 *  be visible to whichSync above; the system tool can sometimes find them.
 *  Returns undefined on any failure — caller decides what to do. */
export function whichViaSystem(bin: string): string | undefined {
  const cmd = IS_WINDOWS ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return out || undefined;
  } catch {
    return undefined;
  }
}
