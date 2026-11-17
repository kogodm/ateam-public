import { resolveClaudeBin } from '../claude-bin';
import { isClaudeModel } from './model-family';
import type { ProviderAdapter, ProviderBuildArgs } from './provider-adapter';

/**
 * Claude Code CLI — the runtime that's been live since M1. Behavior here is
 * a verbatim extraction of what SessionManager.spawn used to inline:
 *   • resume:    --resume <id> [--fork-session]
 *   • new:       --session-id <uuid> --name <short>
 *   • model:     --model <alias|id>            (if the Human binds one)
 *   • recall:    --append-system-prompt <text>   (if non-empty)
 *   • mcp:       --mcp-config <path>             (if non-empty)
 *   • first msg: trailing positional [prompt]    (if non-empty)
 */
export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  resolveBin: () => resolveClaudeBin(),
  buildArgs(a: ProviderBuildArgs): string[] {
    const out: string[] = a.resumeSessionId
      ? ['--resume', a.resumeSessionId, ...(a.forkSession ? ['--fork-session'] : [])]
      : ['--session-id', a.sessionId, '--name', a.sessionName];
    if (a.model && isClaudeModel(a.model)) out.push('--model', a.model);
    if (a.appendSystemPrompt) out.push('--append-system-prompt', a.appendSystemPrompt);
    if (a.settingsJson) out.push('--settings', a.settingsJson);
    if (a.mcpConfigPath) out.push('--mcp-config', a.mcpConfigPath);
    // Trailing positional prompt: claude starts interactive and submits this
    // as the first user turn ITSELF once the TUI is ready. Prefix with `--`
    // to terminate option parsing first — `--mcp-config <configs...>` is
    // VARIADIC, so without the separator it swallows the prompt as an extra
    // config file and claude fails with "ENAMETOOLONG" trying to open the
    // (long) handoff text as a filename.
    if (a.initialPrompt) out.push('--', a.initialPrompt);
    return out;
  },
};
