import type { ProviderAdapter, ProviderBuildArgs } from './provider-adapter';

/**
 * OpenCode CLI adapter (verified against opencode 1.14.22, 2026-05-23).
 *
 * What opencode supports today:
 *   • `opencode [project]`               — start interactive TUI in <project>
 *   • `opencode -s, --session <id>`      — resume a specific session
 *   • `opencode -c, --continue`          — resume the latest session
 *   • `opencode --title <text>`          — set a title for the session
 *   • `opencode --prompt <text>`         — initial user prompt
 *   • `opencode session list/delete`     — manage sessions (separate subcommand)
 *
 * What's NOT supported (and how we work around it):
 *   • Setting a deterministic session id at spawn — opencode generates
 *     its own. SessionManager's claudeSessionId is kept for our internal
 *     event/UI keying; opencode's id (visible via `opencode session list`)
 *     is what the user supplies for resume.
 *   • Injecting a system prompt at startup — `--prompt` is a USER message,
 *     not a system prompt. We do NOT smuggle recalled memory through it
 *     because it would appear as the user's first turn.
 *   • External MCP config file — opencode has its own `opencode mcp`
 *     subcommand for MCP management; we don't try to mount our CodeGraph
 *     MCP into an opencode session today.
 */
export const opencodeAdapter: ProviderAdapter = {
  id: 'opencode',
  resolveBin: () => 'opencode',
  buildArgs(a: ProviderBuildArgs): string[] {
    if (a.resumeSessionId) {
      // resume by opencode's OWN session id (not our claudeSessionId — the
      // caller must have looked it up via `opencode session list`).
      return ['--session', a.resumeSessionId, a.cwd];
    }
    const args: string[] = [a.cwd];
    if (a.sessionName) args.push('--title', a.sessionName);
    return args;
  },
};
