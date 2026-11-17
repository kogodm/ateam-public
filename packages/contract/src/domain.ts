/**
 * Shared domain DTOs. Immutable (readonly). These flow across the contract
 * between the core, the TUI, and (later) the Tauri shell.
 */

/** A directory an agent works in. One Project has N Workspaces (e.g. ./web, ./api). */
export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** absolute path */
  readonly root: string;
  readonly repo?: {
    readonly root: string;
    /** 'worktree' = multiple agents share one repo; 'none' = separate dir/repo */
    readonly isolation: 'worktree' | 'none';
  };
  readonly techStack?: readonly string[];
  readonly defaultRole?: string;
}

/** Binds an agent (role + name) to a workspace. */
export interface RoleSpec {
  readonly role: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly provider?: string;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly workspaces: readonly Workspace[];
  /** user-marked related project ids (never auto-inferred) */
  readonly links?: readonly string[];
}

export type SessionState = 'starting' | 'running' | 'idle' | 'hibernated' | 'exited';

/** The agent-CLI runtimes Ateam can drive. Single source of truth — add a new
 *  provider here (plus its adapter in core) and every consumer picks it up. */
/** every agent-CLI runtime Ateam knows how to drive — the ONE source of
 *  truth (schema enum + ProviderId type both derive from it). */
export const PROVIDER_IDS = ['claude', 'codex', 'opencode', 'cursor'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** One running agent = one agent-CLI PTY session in its workspace cwd. */
export interface SessionNode {
  readonly sessionId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly agentName: string;
  /** the long-term Human asset this session belongs to */
  readonly humanId: string;
  readonly humanName: string;
  /** human-readable session name (claude --name / transcript summary) */
  readonly sessionName: string;
  /** the hat the human wears for this session (attribute, not the key) */
  readonly role: string;
  readonly workspaceId: string;
  readonly cwd: string;
  /** the Claude Code session id (stable; persisted so it can be resumed) */
  readonly claudeSessionId: string;
  readonly state: SessionState;
  /** which agent-CLI runtime drives this session. Absent = claude (the
   *  historical default), so old/restored nodes read as claude. */
  readonly providerId?: ProviderId;
  /** If this session was handed off (auto-handoff), the in-memory id of
   *  the successor that took over. The UI hides such sessions from the
   *  tree (single-row continuity from the user's POV) but still renders
   *  their xterm in the stage's dual-pane stack so the prior chat history
   *  stays visible above the new session. */
  readonly replacedBySessionId?: string;
  /** The model the conversation is currently on, as the runtime records it
   *  ("claude-opus-5", "gpt-5.6-sol"). Read from the transcript, so it costs
   *  nothing and follows a mid-session /model change. '' / absent until the
   *  session has answered once. */
  readonly model?: string;
  /** ISO-8601 birthtime of the claude transcript jsonl (statSync birthtime;
   *  mtime fallback). The session's real lifetime start, NOT app-open time. */
  readonly createdAt?: string;
  /** ISO-8601 mtime of the claude transcript jsonl — last time a REAL
   *  record landed (message/tool activity). Survives GUI restarts; drives
   *  the "recently active" tree filter. */
  readonly lastActiveAt?: string;
  /** A handoff is currently being written for this session (prompt injected,
   *  successor not spawned yet). Server-tracked so a client that connects
   *  MID-handoff — a phone joining while the desktop triggered it — still
   *  renders the handoff overlay instead of a live-looking terminal. */
  readonly handoffInFlight?: boolean;
  /** Set when this session is the hidden backing worker for a chat (chat
   *  mode). The tree/resume UI filters these out entirely — in chat mode the
   *  user talks to teammates and never manages a session. */
  readonly chatId?: string;
}

/** The left-column tree: project -> agent sessions. */
export interface ProjectTree {
  readonly projectId: string;
  /** real, directory-derived name — what persistence and spawn grouping use */
  readonly name: string;
  /** user-set display alias, when there is one. DISPLAY ONLY: render
   *  `alias ?? name`, but keep persisting/sending `name`. */
  readonly alias?: string;
  readonly sessions: readonly SessionNode[];
}

export type TurnRole = 'user' | 'assistant' | 'tool' | 'system';

/** Block-level type of a Turn. Absent on older records = plain text. */
export type TurnKind = 'text' | 'thinking' | 'tool_use' | 'tool_result';

/** A structured transcript turn parsed from the PTY stream. The flywheel
 * consumes these (reflection -> Experience) via session.transcript / session.turn. */
export interface Turn {
  readonly seq: number;
  readonly sessionId: string;
  readonly role: TurnRole;
  readonly text: string;
  /** ISO-8601 timestamp */
  readonly at: string;
  /** block-level type; lets the stream view render tools/thinking properly */
  readonly kind?: TurnKind;
  /** tool_use only: which tool */
  readonly toolName?: string;
  /** tool_use only: the call's own short name, when the tool takes one —
   *  Bash's `description` ("Count to 20 with a tqdm progress bar"), which is
   *  what claude's own task list shows */
  readonly label?: string;
  /** tool_use: the call's id; tool_result: the id of the call it answers.
   *  Parallel calls answer out of adjacency — pair by this, not by order */
  readonly toolUseId?: string;
  /** output_tokens of the record this turn came from (first block only,
   *  so summing over turns never double-counts a record) */
  readonly tokens?: number;
  /** typed while the model was mid-turn and parked in claude's queue */
  readonly queued?: boolean;
  /** the queue released this message — a marker, not something to render */
  readonly dequeued?: boolean;
  /** Claude injected this user-shaped transcript record: a session handoff
   *  prompt, a message the person queued while the model was mid-turn, or the
   *  summary Claude wrote when it compacted its own context. */
  readonly injected?: 'handoff' | 'mid_turn' | 'compaction';
  /** the harness's own injection, which arrives as a "user" record: a loaded
   *  skill's body, a `/context` report, the notice that a response was cut.
   *  `isMeta` in the transcript — the harness labels these itself, so the
   *  view does not have to recognise each new one by its wording. */
  readonly meta?: boolean;
  /** not the model's words but the harness reporting on the turn: 'error' =
   *  the turn failed (API error, usage limit), 'info' = e.g. interrupted */
  readonly notice?: 'error' | 'info';
  /** tool_result of an Edit/Write — or of a bash command that edited files:
   *  the change it made, so the view can show the same diff the terminal
   *  draws instead of "has been updated". One entry per file touched. */
  readonly patch?: readonly {
    readonly file: string;
    readonly hunks: readonly {
      readonly oldStart: number;
      readonly newStart: number;
      /** unified-diff lines: ' ' context, '+' added, '-' removed */
      readonly lines: readonly string[];
    }[];
    /** lines the cap left out, so the card can say "… +N lines" instead of
     *  ending mid-file as if that were the whole change */
    readonly dropped?: number;
  }[];
}

/** A prior Claude Code session on disk that can be resumed (`claude --resume`). */
export interface ClaudeSessionInfo {
  readonly id: string;
  /** ISO-8601 mtime of the session transcript */
  readonly mtime: string;
  /** the session's own title (`/rename` name or AI auto-title); '' if none */
  readonly title: string;
  /** first-message/summary excerpt (fallback context) */
  readonly summary: string;
  /** the Ateam human known to have run this session (session-owners.ts
   *  index), when Ateam has ever spawned/resumed it. Absent for sessions
   *  started outside Ateam, or from before this index existed. */
  readonly humanId?: string;
  /** agent CLI that owns this transcript (absent = claude) */
  readonly providerId?: ProviderId;
}

/** The long-term virtual person. Knowledge is keyed by Human, not role. */
export interface HumanDTO {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly provider?: string;
  /** the model this teammate's sessions run on (CLI alias or full id);
   *  absent = the runtime's own default */
  readonly model?: string;
  /** what this teammate is responsible for; injected into their sessions */
  readonly duties?: string;
  readonly notes?: string;
  readonly avatarId?: string;
  readonly experienceSummary?: { readonly text: string; readonly at: string };
  readonly createdAt: string;
  readonly projects: readonly {
    dir: string;
    /** stable readable project key (per-project vault scope) */
    key?: string;
    /** human-readable project name */
    name?: string;
    firstSeen: string;
    lastSeen: string;
  }[];
}

/** One entry of the shared "last open session set"
 *  (`~/.ateam/tui-state.json`), restored by both the TUI and the GUI. */
export interface SessionStateAgent {
  readonly projectName: string;
  readonly agentName: string;
  readonly role: string;
  readonly dir: string;
  readonly claudeSessionId: string;
  readonly directoryless?: boolean;
  /** agent CLI that drove the session (absent = claude, pre-provider files) */
  readonly providerId?: ProviderId;
  /** ISO timestamp of the last real transcript record — enriched by
   *  sessionState.get so restore can decide live-spawn vs hibernate. */
  readonly lastActiveAt?: string;
  /** This conversation is ALREADY running, as one of Claude Code's background
   *  agents (`claude --bg`). Enriched by sessionState.get. Restore leaves it
   *  alone: a background agent is not something to resume — it is running, and
   *  `--resume` refuses it. The row is registered without booting anything,
   *  the same as a hibernated one. */
  readonly backgroundAgent?: boolean;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
