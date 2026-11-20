import { constants, accessSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { loginShellEnv } from '../../platform';
import type { ProviderAdapter, ProviderBuildArgs } from './provider-adapter';

export interface AgyBinSearchOptions {
  path?: string;
  home?: string;
  /** PATH from the user's login shell. Empty means do not search it. */
  loginPath?: string;
}

/**
 * Resolve the Antigravity CLI binary (`agy`). Prefer PATH, then
 * `~/.local/bin` (the official install.sh default), then the login-shell PATH.
 */
export function resolveAgyBin(options: AgyBinSearchOptions = {}): string | undefined {
  const processPath = options.path ?? process.env.PATH ?? '';
  const home = options.home ?? homedir();
  const dirs = [
    ...processPath.split(delimiter).filter(Boolean),
    join(home, '.local', 'bin'),
    ...(options.loginPath ?? loginShellEnv().PATH ?? '').split(delimiter).filter(Boolean),
  ];
  for (const dir of new Set(dirs)) {
    const candidate = join(dir, 'agy');
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep searching
    }
  }
  return undefined;
}

export function requireAgyBin(resolve: () => string | undefined = resolveAgyBin): string {
  const bin = resolve();
  if (!bin) {
    throw new Error(
      'Antigravity CLI not found (expected `agy`). Install it from https://antigravity.google/docs (curl -fsSL https://antigravity.google/cli/install.sh | bash).',
    );
  }
  return bin;
}

/**
 * Antigravity CLI adapter (`agy`), verified against official CLI flag docs
 * (https://antigravity.google/docs/cli/reference/, headless + conversations
 * pages) and measured against agy 1.5.x.
 *
 * What agy supports today (interactive TUI spawn):
 *   • `agy`                                      — fresh interactive session
 *   • `agy --conversation <id>`                  — resume by conversation id
 *   • `agy -i/--prompt-interactive <text>`       — submit an initial user turn
 *   • `agy --model <slug>`                       — model for this session
 *
 * What we deliberately do NOT wire (no verified per-invocation flag):
 *   • Caller-set conversation id at spawn — agy assigns its own id.
 *   • Hidden system / developer prompt — no `--append-system-prompt` equivalent
 *     documented; we do not smuggle recall through `-i` (it is a USER message).
 *   • External MCP config file — MCP is configured via
 *     `~/.gemini/config/mcp_config.json` or workspace `.agents/mcp_config.json`,
 *     not a spawn flag. Mounting Ateam session MCP without a verified
 *     invocation-scoped flag would mutate shared user config.
 */
export const antigravityAdapter: ProviderAdapter = {
  id: 'antigravity',
  resolveBin: () => requireAgyBin(),
  buildArgs(a: ProviderBuildArgs): string[] {
    const out: string[] = [];
    if (a.resumeSessionId) {
      // Resume by agy's OWN conversation id (from a prior run / /resume picker).
      out.push('--conversation', a.resumeSessionId);
    }
    if (a.model) out.push('--model', a.model);
    // `-i` keeps the TUI open after the first turn (unlike `-p` print mode).
    if (a.initialPrompt) out.push('--prompt-interactive', a.initialPrompt);
    return out;
  },
};
