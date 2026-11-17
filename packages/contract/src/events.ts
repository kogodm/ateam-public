import type { LogLevel, SessionState, Turn } from './domain';
import type { ExternalRunDTO } from './methods';

/**
 * Typed server -> client event registry. `session.*` + `log` are live (M1).
 * `evolution.*` / `growth.report` are reserved in the frozen contract so the
 * growth visualization can be built from day one and wired to real data in M2.
 */
export interface Events {
  'externalMcp.changed': Record<string, never>;
  // --- session skeleton (live: M1) ---
  'session.output': { sessionId: string; chunk: string };
  'session.status': { sessionId: string; state: SessionState; exitCode?: number };
  'session.turn': { sessionId: string; turn: Turn };
  /** Progress from a standalone external MCP command, separate from the CLI transcript. */
  'session.externalRun': { sessionId: string; run: ExternalRunDTO };
  /** Auto-handoff completed: a successor session has been spawned to take
   *  over from `oldSessionId`. The handoff document claude wrote is at
   *  `handoffPath`; its content was injected into the successor as
   *  --append-system-prompt so the new session starts already-briefed.
   *  The UI swaps focused to the new session and renders the dual-pane
   *  stack (old read-only above, banner, new below). */
  'session.replaced': {
    oldSessionId: string;
    newSessionId: string;
    /** stable resume ids — used by the UI to retire the old session's
     *  entry from tui-state.json and slot the successor in its place
     *  (single-row continuity from the user's POV). */
    oldClaudeSessionId: string;
    newClaudeSessionId: string;
    handoffPath: string;
    /** ISO-8601 timestamp the swap completed */
    at: string;
  };
  /** Terminal size ownership for a session changed. A PTY has ONE size, so
   *  with several clients attached the layout belongs to whoever is working in
   *  it; `youControl` is addressed to the receiving client specifically (this
   *  event is sent per connection, not broadcast identically). A client that
   *  does not control the size renders a frame laid out for someone else's
   *  screen — it can say so instead of just looking wrong. */
  'session.control': { sessionId: string; youControl: boolean };
  /** The PTY was resized (by whoever holds control — see `session.control`).
   *  A terminal emulator that cannot measure itself — the stream view keeps
   *  every Term `display:none`, so its xterm silently keeps the 80×24 default
   *  — must follow this, otherwise the screen it reads back is a frame drawn
   *  for someone else's size, wrapped into nonsense. That is what stopped
   *  claude's own pickers (/model, permission prompts) from ever being
   *  recognised on a phone. */
  'session.size': { sessionId: string; cols: number; rows: number };
  /** A watched directory changed on disk (fs.watch/fs.unwatch manage the
   *  subscriptions). `paths` is a debounced, capped sample of relative
   *  paths — treat it as "something under `dir` changed", not a full list. */
  'fs.changed': { dir: string; paths: string[] };
  /** The task store changed (added / completed / removed / reminded) — by
   *  the desktop OR by an agent via the MCP server. The UI refetches. */
  'task.changed': Record<string, never>;
  'chat.changed': { chatId?: string };
  /** A task's scheduled reminder just fired (one-shot). The UI raises an OS
   *  notification and highlights the row. */
  'task.due': {
    id: string;
    title: string;
    project: string;
  };
  log: { level: LogLevel; msg: string };

  // --- reserved evolution spine (typed, wired in M2) ---
  'evolution.proficiency': {
    agentId: string;
    skillRef: string;
    from: string;
    to: string;
    reason: string;
  };
  'evolution.transform': {
    agentId: string;
    kind: 'distill' | 'crystallize' | 'abstract';
    sourceRefs: string[];
    producedRef: string;
  };
  'evolution.decay': {
    agentId: string;
    assetRef: string;
    oldConf: number;
    newConf: number;
    reason: string;
  };
  'evolution.expertise': {
    agentId: string;
    domain: string;
    level: string;
    score: number;
    delta: number;
  };
  'growth.report': { agentId: string; range: string; series: unknown[]; highlights: string[] };
  /** a new Experience was captured by the flywheel (M2 live) */
  'evolution.experience': {
    agentKey: string;
    domain: string;
    title: string;
    scope: 'project' | 'global';
  };
  /** skills/knowledge imported or learned for a role (M2 live) */
  'evolution.skill': {
    agentKey: string;
    source: 'user_provided' | 'distilled' | 'learned';
    count: number;
  };
  /** autonomous Meta-Agent lifecycle/progress (for the status bar) */
  'meta.progress': {
    phase: 'reflect' | 'distill' | 'decay' | 'done';
    detail: string;
  };
}

export type EventTopic = keyof Events;
export type EventData<T extends EventTopic> = Events[T];
