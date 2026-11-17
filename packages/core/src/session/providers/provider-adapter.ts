/**
 * One agent-CLI runtime — claude / codex / opencode / future. SessionManager
 * is the glue: it owns the PTY/transcript/event lifecycle; the adapter
 * decides what binary to spawn and what flags to pass.
 *
 * Stays MINIMAL on purpose: anything claude-specific that isn't generalizable
 * (e.g. drops-inbox protocol, transcript shape) goes elsewhere keyed by
 * provider id; here we only own the spawn surface.
 */
// Single source of truth lives in the contract so core + UI + protocol agree.
export type { ProviderId } from '@ateam/contract';
import type { ProviderId } from '@ateam/contract';

export interface ProviderBuildArgs {
  /** the deterministic session id we want this conversation keyed by, so
   *  resume works later. Adapter passes it via whatever flag the CLI uses
   *  (claude: --session-id; codex/opencode: TBD). */
  sessionId: string;
  /** The manager's live row id differs from a resumed provider thread id.
   *  Host tools must address this row even after the provider rotates ids. */
  ateamSessionId?: string;
  /** if set, resume an existing on-disk session with this id (instead of
   *  starting fresh). Mutually exclusive with treating sessionId as new. */
  resumeSessionId?: string;
  /** Resume by branching a COPY instead of re-opening the conversation
   *  (claude: --fork-session). Claude Code refuses to resume a session that is
   *  already running as a background agent; forking is the CLI's own suggested
   *  way through, and the fork's new id is picked up by the SessionStart hook
   *  the same way a /clear rotation is. */
  forkSession?: boolean;
  /** short human-readable label (claude --name). Optional — the CLI may
   *  not support it. */
  sessionName: string;
  /** absolute cwd the PTY runs in (the workspace root or human desk). */
  cwd: string;
  /** recall text the spawn should pre-load as system context. For claude
   *  this is `--append-system-prompt <text>`; Codex receives the same text
   *  through an invocation-scoped `developer_instructions` override.
   *  OpenCode has no verified equivalent yet. Empty string = nothing. */
  appendSystemPrompt: string;
  /** extra settings JSON merged in via `claude --settings` (a SessionStart
   *  hook that reports session-id rotation on /clear). Empty = none. */
  settingsJson?: string;
  /** absolute path to an MCP config JSON we want loaded (claude: --mcp-config).
   *  Empty string = none. Adapter may ignore if the CLI doesn't support MCP. */
  mcpConfigPath: string;
  /** the model the session runs on, as the CLI's own flag takes it (claude
   *  `--model`, codex `-m`): an alias ('opus') or a full id. Comes from the
   *  Human's `model` binding; empty/undefined = the runtime's own default. */
  model?: string;
  /** an initial user message the CLI should submit as the FIRST turn once its
   *  TUI is ready. For claude this is the trailing positional `[prompt]` arg —
   *  the CLI submits it itself, so we don't have to race a bracketed-paste
   *  into a freshly-booting TUI. Used by auto-handoff to deliver the handoff
   *  doc to the successor. Empty/undefined = none. */
  initialPrompt?: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  /** binary to spawn — adapter resolves via PATH / well-known install dirs. */
  resolveBin(): string;
  /** argv (without the binary itself) for ptySpawn. */
  buildArgs(args: ProviderBuildArgs): string[];
}

/** Thrown by stub adapters until each CLI's resume / system-prompt / MCP
 *  conventions are verified empirically. Keep the message useful — it bubbles
 *  back to the GUI as the session.spawn error so the user sees what's missing. */
export class ProviderNotImplementedError extends Error {
  readonly code = 'provider_not_implemented';
  constructor(id: ProviderId, detail: string) {
    super(`provider ${id} runtime not wired yet: ${detail}`);
    this.name = 'ProviderNotImplementedError';
  }
}
