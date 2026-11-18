import {
  constants,
  accessSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { ateamHome } from '../../paths';
import { loginShellEnv, mergedPath } from '../../platform';
import { buildCursorInitialPrompt } from './cursor-recall';
import type { ProviderAdapter, ProviderBuildArgs } from './provider-adapter';

type CursorMcpServer = { command: string; args: string[]; env: Record<string, string> };

export interface CursorBinSearchOptions {
  /** PATH from the hosting process (often minimal when launched from Finder). */
  path?: string;
  home?: string;
  /** PATH from the user's login shell. Empty means do not search it. */
  loginPath?: string;
}

/** Search only for Cursor's agent CLI executable; never fall back to the GUI `cursor` command. */
export function resolveCursorBin(options: CursorBinSearchOptions = {}): string | undefined {
  const processPath = options.path ?? process.env.PATH ?? '';
  const home = options.home ?? homedir();
  const localDirs = [...processPath.split(delimiter).filter(Boolean), join(home, '.local', 'bin')];
  const findExecutable = (
    dirs: string[],
    name: string,
    accept: (candidate: string) => boolean = () => true,
  ): string | undefined => {
    const candidates = dirs.map((dir) => join(dir, name));
    for (const candidate of new Set(candidates)) {
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile() && accept(candidate)) return candidate;
      } catch {
        // Keep searching the explicitly supported Cursor CLI locations.
      }
    }
    return undefined;
  };
  const localCursorAgent = findExecutable(localDirs, 'cursor-agent');
  if (localCursorAgent) return localCursorAgent;

  const loginPath = options.loginPath ?? loginShellEnv().PATH ?? '';
  const searchDirs = [...localDirs, ...loginPath.split(delimiter).filter(Boolean)];

  // Prefer the unambiguous command name across all supported PATH sources.
  const cursorAgent = findExecutable(searchDirs, 'cursor-agent');
  if (cursorAgent) return cursorAgent;

  // The short `agent` name is shared by unrelated tools. Accept it only when
  // its canonical target is in Cursor's official versioned install tree.
  return findExecutable(searchDirs, 'agent', (candidate) => {
    try {
      const parts = realpathSync(candidate).split(sep);
      const installRoot = parts.indexOf('cursor-agent');
      return parts.at(-1) === 'cursor-agent' && parts[installRoot + 1] === 'versions';
    } catch {
      return false;
    }
  });
}

export function requireCursorBin(resolve: () => string | undefined = resolveCursorBin): string {
  const bin = resolve();
  if (!bin) {
    throw new Error(
      'Cursor CLI not found (expected `cursor-agent`). Install it from https://cursor.com/install; the Cursor GUI `cursor` command is not supported.',
    );
  }
  return bin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Cursor's plugin loader reads MCP servers from the plugin's `mcp.json`.
 * Copy only the already-generated session MCP servers, preserving their
 * command/argv and existing env while explicitly supplying the sidecar's
 * runtime home and merged PATH.
 */
function writeCursorPlugin(mcpConfigPath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
  } catch {
    throw new Error(`Cursor MCP config is missing or invalid: ${mcpConfigPath}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers))
    throw new Error(`Cursor MCP config is missing or invalid: ${mcpConfigPath}`);

  const path = mergedPath();
  const servers: Record<string, CursorMcpServer> = {};
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    if (
      !isRecord(value) ||
      typeof value.command !== 'string' ||
      !value.command ||
      !Array.isArray(value.args) ||
      !value.args.every((arg) => typeof arg === 'string')
    )
      throw new Error(`Cursor MCP config is missing or invalid: ${mcpConfigPath}`);
    const env = value.env ?? {};
    if (!isRecord(env) || Object.values(env).some((entry) => typeof entry !== 'string'))
      throw new Error(`Cursor MCP config is missing or invalid: ${mcpConfigPath}`);
    servers[name] = {
      command: value.command,
      args: value.args as string[],
      env: { ...(env as Record<string, string>), ATEAM_HOME: ateamHome(), PATH: path },
    };
  }

  const plugin = mkdtempSync(join(tmpdir(), 'ateam-cursor-mcp-'));
  try {
    const metadataDir = join(plugin, '.cursor-plugin');
    mkdirSync(metadataDir, { mode: 0o700 });
    chmodSync(plugin, 0o700);
    chmodSync(metadataDir, 0o700);
    writeFileSync(join(plugin, 'mcp.json'), JSON.stringify({ mcpServers: servers }), {
      mode: 0o600,
      flag: 'wx',
    });
    writeFileSync(
      join(metadataDir, 'plugin.json'),
      JSON.stringify({ name: 'ateam-session', version: '0.1.0', mcpServers: './mcp.json' }),
      { mode: 0o600, flag: 'wx' },
    );
    return plugin;
  } catch (error) {
    rmSync(plugin, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Cursor CLI's verified surface is deliberately kept small here:
 *   • fresh: `cursor-agent [initial prompt]`
 *   • resume: `cursor-agent --resume=<chatId> [initial prompt]`
 *
 * There is no verified hidden system-prompt flag. Human recall is folded into
 * the positional prompt (see `cursor-recall.ts`) and stripped from the stream
 * via the `<ateam_human_recall>` wrapper. MCP servers stay on an
 * invocation-scoped plugin-dir. Model ids are omitted until a Cursor-specific
 * accepted-id policy is verified; Claude/Codex bindings must not be forwarded
 * blindly.
 */
export const cursorAdapter: ProviderAdapter = {
  id: 'cursor',
  resolveBin: () => requireCursorBin(),
  buildArgs(args: ProviderBuildArgs): string[] {
    const out: string[] = [];
    if (args.resumeSessionId) {
      out.push(`--resume=${args.resumeSessionId}`);
    }
    if (args.mcpConfigPath) {
      const plugin = writeCursorPlugin(args.mcpConfigPath);
      out.push('--plugin-dir', plugin);
    }
    const prompt = buildCursorInitialPrompt(args);
    if (prompt) out.push(prompt);
    return out;
  },
};
