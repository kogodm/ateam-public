import { readFileSync } from 'node:fs';
import { getPrompt } from '../../prompts';
import { resolveCodexBin } from '../codex-bin';
import { sessionMcpServers } from '../mcp-config';
import { isClaudeModel } from './model-family';
import type { ProviderAdapter, ProviderBuildArgs } from './provider-adapter';

/**
 * Codex CLI adapter (verified against codex-cli 0.147, 2026-08-16).
 *
 * What codex's interactive CLI supports today:
 *   • `codex [PROMPT]`                    — start an interactive TUI session,
 *                                           optional initial prompt as positional
 *   • `codex -C <DIR>`                    — set working directory
 *   • `codex resume <THREAD_ID> [PROMPT]` — re-open a saved thread interactively
 *   • `codex -c developer_instructions=...` — add per-session developer
 *                                             instructions without turning them
 *                                             into a visible user message
 *
 * What codex does NOT support (and therefore Ateam works around):
 *   • Setting a session id at spawn — codex assigns its own thread id. The
 *     manager discovers it from ~/.codex/sessions after the first turn and
 *     re-keys the session (see providers/codex-sessions.ts). Resume only
 *     works once that discovery has happened; before it, `resumeSessionId`
 *     points at our placeholder UUID, the manager's store check finds no
 *     rollout and falls back to a fresh spawn.
 * External MCPs mount with `-c mcp_servers.NAME.command/args` (verified
 * against codex 0.162). Claude-style --mcp-config files are not consumed;
 * the peer bridge is mounted below with invocation-scoped TOML overrides.
 */
export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  resolveBin: () => resolveCodexBin() ?? 'codex',
  buildArgs(a: ProviderBuildArgs): string[] {
    // -C <cwd> is the only handle we have to pin the working directory.
    // node-pty's spawn cwd handles this too, but passing -C explicitly is
    // robust against codex internally resolving paths relative to PWD.
    const args = a.resumeSessionId ? ['resume', a.resumeSessionId, '-C', a.cwd] : ['-C', a.cwd];
    if (a.model && !isClaudeModel(a.model)) args.push('-m', a.model); // see model-family.ts
    // Codex has no Claude-style --append-system-prompt flag, but its
    // developer_instructions config is the exact equivalent we need here:
    // it is additive (so project AGENTS.md still applies), invocation-scoped
    // (so concurrent Humans cannot leak memory into one another), and hidden
    // from the user's conversation. JSON string syntax is valid TOML string
    // syntax and safely carries quotes/newlines through one argv element.
    const instructions = [a.appendSystemPrompt, getPrompt('codexProgress').trim()]
      .filter(Boolean)
      .join('\n\n');
    if (instructions) args.push('-c', `developer_instructions=${JSON.stringify(instructions)}`);
    const servers: ReturnType<typeof sessionMcpServers> = a.mcpConfigPath
      ? JSON.parse(readFileSync(a.mcpConfigPath, 'utf8')).mcpServers
      : sessionMcpServers(a.ateamSessionId ?? a.sessionId, a.cwd);
    for (const [name, server] of Object.entries(servers)) {
      const key = name.replaceAll('-', '_');
      args.push('-c', `mcp_servers.${key}.command=${JSON.stringify(server.command)}`);
      args.push('-c', `mcp_servers.${key}.args=${JSON.stringify(server.args)}`);
      args.push('-c', `mcp_servers.${key}.cwd=${JSON.stringify(a.cwd)}`);
    }
    return a.initialPrompt ? [...args, a.initialPrompt] : args;
  },
};
