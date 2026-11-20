import type { ProviderId } from '@ateam/contract';
import { whichSync, whichViaSystem } from './platform';
import { resolveCodexBin } from './session/codex-bin';
import { resolveAgyBin } from './session/providers/antigravity-adapter';
import { resolveCursorBin } from './session/providers/cursor-adapter';

/** The agent-CLI runtimes Ateam knows about. Claude is fully wired; Cursor,
 *  Codex, OpenCode, and Antigravity expose the verified subset documented by
 *  their adapters. */
export interface ProviderInfo {
  id: ProviderId;
  label: string;
  binName: string;
  available: boolean;
  path?: string;
  /** Whether SessionManager can actually spawn this provider's CLI today.
   *  When false the provider is detected for UI purposes only; selecting
   *  it for session.spawn yields ProviderNotImplementedError. */
  runtimeSupported: boolean;
}

export function listProviders(): ProviderInfo[] {
  const defs: {
    id: ProviderInfo['id'];
    label: string;
    binName: string;
    runtimeSupported: boolean;
  }[] = [
    // Wired against:
    //   claude       full (resume, set session id, append-system-prompt, MCP)
    //   codex        partial — new + resume-by-codex-thread-id, recall through
    //                developer_instructions (no caller-set id or external MCP)
    //   opencode     partial — new + resume-by-opencode's-own-id (no caller-
    //                set session id, no system-prompt flag, no external MCP)
    //   cursor       partial — new/resume + plugin MCP; recall via initialPrompt
    //   antigravity  partial — new + resume-by-agy-conversation-id + --model +
    //                --prompt-interactive (no caller-set id, hidden recall, or
    //                invocation-scoped MCP flag)
    // runtimeSupported marks providers whose session-spawn adapter is wired;
    // per-provider limitations are documented by the adapter itself.
    { id: 'claude', label: 'Claude Code', binName: 'claude', runtimeSupported: true },
    { id: 'codex', label: 'Codex CLI', binName: 'codex', runtimeSupported: true },
    { id: 'opencode', label: 'OpenCode CLI', binName: 'opencode', runtimeSupported: true },
    { id: 'cursor', label: 'Cursor CLI', binName: 'cursor-agent', runtimeSupported: true },
    { id: 'antigravity', label: 'Antigravity CLI', binName: 'agy', runtimeSupported: true },
  ];
  return defs.map((d) => {
    // codex may only exist inside the ChatGPT / Codex desktop app bundle;
    // cursor-agent / agy also live under ~/.local/bin outside a minimal PATH.
    const p =
      d.id === 'codex'
        ? resolveCodexBin()
        : d.id === 'cursor'
          ? resolveCursorBin()
          : d.id === 'antigravity'
            ? resolveAgyBin()
            : (whichSync(d.binName) ?? whichViaSystem(d.binName));
    return { ...d, available: !!p, path: p };
  });
}
