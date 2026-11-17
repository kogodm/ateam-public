import type {
  ClaudeSessionInfo,
  HumanDTO,
  ProjectTree,
  ProviderId,
  RoleSpec,
  SessionNode,
  SessionStateAgent,
  Turn,
  Workspace,
} from './domain';
import type { ExternalMcpStatus } from './external-mcp';

type Empty = Record<string, never>;

export interface SyncStatus {
  /** sync is turned on for this device */
  enabled: boolean;
  /** signed in to a relay account (config.remote with an accountId) */
  signedIn: boolean;
  email: string;
  deviceId: string;
  /** the data key is available on this device (else: enter the passphrase) */
  unlocked: boolean;
  /** a pass is running right now */
  syncing: boolean;
  /** ISO time of the last successful pass */
  lastSyncAt?: string;
  lastError?: string;
  /** records sent / received in the last pass */
  lastPushed?: number;
  lastPulled?: number;
  /** conflict copies written in the last pass */
  lastConflicts?: number;
}

export interface SyncDevice {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  /** this machine */
  current: boolean;
}

/** A standalone external MCP command associated with a session, not CLI transcript content. */
export interface ExternalRunDTO {
  executionId: string;
  sessionId: string;
  tool: string;
  command: string;
  status: 'running' | 'exited' | 'timed_out' | 'cancelled' | 'failed_to_start';
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  output: string;
  truncated: boolean;
}

/**
 * Typed RPC method registry. `session.*` is the live surface that powers the
 * first-version session multiplexer. The rest are reserved in the frozen
 * contract (typed now, implemented in later milestones) so the protocol
 * version need not bump when they come online.
 */
/** A prompt as Settings → Prompts shows it (see core prompts.ts). */
export interface PromptInfoDTO {
  name: string;
  title: string;
  /** when the app sends it */
  when: string;
  /** false: nothing triggers it by default any more */
  live: boolean;
  customized: boolean;
  text: string;
  defaultText: string;
  placeholders: string[];
}

export interface VideoChunkDTO {
  mime: 'video/mp4' | 'video/webm' | 'video/quicktime';
  size: number;
  offset: number;
  version: string;
  base64: string;
}

export interface Methods {
  'externalMcp.status': { params: Empty; result: ExternalMcpStatus };
  'externalMcp.register': {
    params: { client: 'claude-desktop' | 'chatgpt' | 'cursor-desktop' };
    result: { path: string; restartRequired: boolean; plugin?: ExternalMcpStatus['chatgptPlugin'] };
  };
  'externalMcp.decide': { params: { id: string; allow: boolean; projects: string[] }; result: { ok: true } };
  'externalMcp.decideRequest': { params: { id: string; allow: boolean }; result: { ok: true } };
  'externalMcp.revoke': { params: { id: string }; result: { ok: true } };
  'externalMcp.retry': { params: { id: string }; result: { ok: true } };
  // --- session skeleton (live: M1) ---
  'session.spawn': {
    params: {
      /** existing project id, or omit to create a new project */
      projectId?: string;
      projectName?: string;
      agentName: string;
      role: string;
      /** the Human this agent is; if omitted, derived from {agentName,role} */
      human?: { id?: string; name: string; role: string; provider?: string };
      /** the dir this agent works in; omit (or set directoryless) to talk to
       *  a human with NO fixed project — the agent navigates via its own
       *  knowledge/skills (Bash `cd`) during the conversation. */
      workspace?: Workspace;
      /** directory-less session: bind only to the Human, no project/cwd */
      directoryless?: boolean;
      /** resume an existing Claude Code session instead of starting fresh */
      resumeSessionId?: string;
      /** which agent-CLI runtime drives this session. 'claude' is the only
       *  one fully wired today; 'codex'/'opencode' are detected by
       *  provider.list but their session.spawn currently throws
       *  ProviderNotImplementedError until each adapter is verified
       *  against the real binary. */
      providerId?: ProviderId;
      /** initial PTY size; size to the destination pane to avoid relayout garble */
      cols?: number;
      rows?: number;
    };
    result: { session: SessionNode };
  };
  /** Past conversations to resume, newest first. Either for a directory
   *  (`cwd`) or — with no directory — a human's directory-less sessions
   *  (`humanId`: the ones that ran on that human's desk). One of the two. */
  'claude.sessions': {
    params: { cwd?: string; humanId?: string };
    result: { sessions: ClaudeSessionInfo[] };
  };
  /** Put a live session to sleep: kill its PTY (~300MB/claude process) but
   *  keep the node in the tree as state 'hibernated'. Idle sessions are
   *  also swept here automatically (config.hibernate). */
  'session.hibernate': {
    params: { sessionId: string };
    result: Empty;
  };
  /** Wake a hibernated session: respawn its PTY with --resume. The node is
   *  REPLACED — the result carries the successor (new sessionId, same
   *  claudeSessionId / conversation). */
  'session.wake': {
    params: {
      sessionId: string;
      /** Open a forked COPY (claude --fork-session). The only way into a
       *  conversation that is already running as a background agent, which
       *  otherwise fails with code `bg_agent_running` — the original keeps
       *  running, so this is always the user's explicit choice. */
      fork?: boolean;
    };
    result: { session: SessionNode };
  };
  /** Register a session in the tree directly in the hibernated state —
   *  restore uses this for stale sessions instead of booting claude. */
  'session.addHibernated': {
    params: {
      projectName: string;
      agentName: string;
      role: string;
      dir: string;
      claudeSessionId: string;
      directoryless?: boolean;
      providerId?: ProviderId;
    };
    result: { session: SessionNode };
  };
  'session.input': {
    params: { sessionId: string; data: string };
    /** held: the session is handing off — the input was kept for its
     *  successor (sent once it is up) instead of typed into this one */
    result: { held?: boolean };
  };
  /** Up in the CLI while it works: its queued messages leave the queue (the
   *  caller now holds them in its composer), and `clearChars` Backspaces
   *  empty the TUI's input box they were moved into. */
  /** Paths under `dir` (relative; directories end in `/`) matching `query`
   *  by name, best first — the stream composer's `@` menu. */
  'files.search': {
    params: { dir: string; query: string; limit?: number };
    result: { paths: string[] };
  };
  'session.pullQueue': {
    params: { sessionId: string; clearChars: number };
    result: Record<string, never>;
  };
  /** Tell the core how big the client's terminal pane is BEFORE any session
   *  exists — the first spawns after app start then boot claude at the real
   *  width instead of the 120×32 fallback (which painted a narrow banner that
   *  stayed mangled in the scrollback). */
  'session.viewport': {
    params: { cols: number; rows: number };
    result: Empty;
  };
  'session.resize': {
    params: { sessionId: string; cols: number; rows: number };
    result: Empty;
  };
  /** "I am the one using this session now." A PTY has exactly one size, so with
   *  a phone and a desktop attached to the same session somebody has to win —
   *  the winner is whoever is actually working in it. Sent on real interaction
   *  (typing, clicking into the terminal, returning to the window), never on
   *  merely connecting, so a phone left on a desk cannot squeeze the desktop.
   *  The client's own last reported size is applied to the PTY immediately,
   *  which reflows exactly like dragging a window wider. */
  'session.activate': {
    params: { sessionId: string };
    result: Empty;
  };
  'session.list': {
    params: Empty;
    result: { projects: ProjectTree[] };
  };
  'session.kill': {
    params: { sessionId: string };
    result: Empty;
  };
  /** Permanently remove a session: kill its PTY AND drop it from the
   *  in-memory map so it disappears from the tree entirely (session.kill
   *  only ends the PTY, leaving an 'exited' tombstone). The GUI also
   *  forgets it from tui-state.json so it won't return on restart. */
  'session.delete': {
    params: { sessionId: string };
    result: Empty;
  };
  'session.transcript': {
    params: { sessionId: string; since?: number };
    /** `fromByte` is where this (tail) window starts in the transcript file;
     *  `hasMore` says older history exists — fetch it with session.olderTranscript. */
    result: { turns: Turn[]; fromByte?: number; hasMore?: boolean };
  };
  /** Recent standalone external MCP executions associated with this session. */
  'session.externalRuns': {
    params: { sessionId: string };
    result: { runs: ExternalRunDTO[] };
  };
  /** One window of OLDER history, ending just before `beforeByte`. Walks the
   *  transcript backwards so scrolling up never parses the whole file. */
  /** Sub-agents this session launched. Their conversations are NOT in the
   *  session's transcript (every record there is isSidechain:false) — the
   *  harness writes each one its own jsonl, which is what this reads. */
  'session.subagents': {
    params: { sessionId: string };
    result: { agents: SubagentDTO[] };
  };
  /** One sub-agent's conversation, in the same Turn blocks a session's own
   *  transcript yields, so the stream renders both the same way. */
  'session.subagentTranscript': {
    params: { sessionId: string; agentId: string };
    result: { turns: Turn[] };
  };
  /** Commands this session left running in the background. Still-running
   *  first; `done` comes from the harness's exit marker in the output file,
   *  not from a process lookup, so it survives a restart. */
  'session.bgShells': {
    params: { sessionId: string };
    result: { shells: BgShellDTO[] };
  };
  /** The tail of one backgrounded command's output. */
  'session.bgShellOutput': {
    params: { sessionId: string; id: string; tailBytes?: number };
    /** `logPath`: the command redirected its output there, and that file is
     *  what `text` is the tail of */
    result: {
      text: string;
      bytes: number;
      truncated: boolean;
      done: boolean;
      exitCode?: number;
      logPath?: string;
      /** the full command the task was started with, and claude's name for it */
      command?: string;
      label?: string;
      /** files the command is writing with -o / -O, and their size now */
      files?: { path: string; bytes: number; mtimeMs: number }[];
    };
  };
  'session.olderTranscript': {
    params: { sessionId: string; beforeByte: number };
    result: { turns: Turn[]; fromByte: number; hasMore: boolean };
  };
  /** Last ~120KB of the session's raw PTY output — a terminal that attaches
   *  AFTER the fact (phone / LAN / second window) replays it so it is not
   *  blank until the next repaint. */
  /** Store a file sent from a client (a phone's photo) on this machine so a
   *  session can be pointed at it — returns the absolute path to paste. */
  'file.upload': {
    params: { name: string; base64: string };
    result: { path: string; bytes: number };
  };
  'session.raw': {
    params: { sessionId: string };
    /** `cols`/`rows` are the PTY's CURRENT size. A client that cannot measure
     *  its own terminal (the stream view keeps every Term display:none) must
     *  lay its emulator out at this size or the frame it reads back is
     *  wrapped garbage — see `session.size` for later changes. */
    result: { raw: string; cols?: number; rows?: number };
  };
  /** Rebind a live session to a different Human. Doesn't kill the PTY (the
   *  Claude CLI's --name is baked in at spawn) — only changes the UI label,
   *  the agentKey for future flywheel/drops/recall attribution, and records
   *  the new Human's project participation. */
  'session.reassignHuman': {
    params: { sessionId: string; humanId: string };
    result: { session: SessionNode };
  };

  // --- flywheel (live: M2) ---
  'flywheel.reflect': {
    params: { sessionId: string };
    result: {
      saved: boolean;
      experience?: ExperienceHit;
      counts?: { experiences: number; skills: number; knowledge: number };
    };
  };
  'asset.search': {
    params: { agentKey: string; query: string; domain?: string; projectId?: string };
    result: { hits: ExperienceHit[] };
  };
  'skill.sources': {
    params: { projectDir?: string };
    result: { sources: SkillSourceDTO[] };
  };
  'skill.units': {
    params: { projectDir?: string };
    result: { units: SkillUnitDTO[] };
  };
  'skill.importUnit': {
    params: {
      humanId: string;
      unitPath: string;
      kind: 'file' | 'bundle' | 'tree';
      entry: string;
      scope?: 'project' | 'global';
    };
    result: { imported: number };
  };
  /** Adopt (move-to-vault + symlink) every skill found in the dirs a Human
   *  has worked in. `humanId` = one human; `all` = one-time backfill sweep
   *  over every human (idempotent; guarded so it runs once after upgrade). */
  'skill.adoptHumanDirs': {
    params: { humanId?: string; all?: boolean };
    result: { adopted: number; dirs: number };
  };
  'skill.import': {
    params: { agentKey: string; dir: string; scope?: 'project' | 'global' };
    result: { imported: number };
  };
  'skill.learn': {
    params: { agentKey: string; projectDir: string; scope?: 'project' | 'global' };
    result: { learned: number };
  };
  'meta.runNow': {
    params: Empty;
    result: { reflected: number; distilled: number };
  };
  'project.recent': {
    params: Empty;
    result: { dirs: RecentProjectDTO[] };
  };
  'workspace.info': {
    params: { dir: string; fresh?: boolean };
    result: { info: WorkspaceInfoDTO };
  };
  /** Git repos to offer in the panel's repo switcher: the dir itself when it's
   *  a repo, else repos found by a shallow scan of its subdirectories — so a
   *  parent folder that only *holds* several repos can switch between them. */
  'workspace.repos': {
    params: { dir: string };
    result: { repos: string[] };
  };
  /** Subscribe this client's interest in a dir — fs.changed events fire on
   *  modifications (recursive, debounced). Ref-counted; pair with
   *  fs.unwatch. ok:false = platform can't watch → caller should poll. */
  'fs.watch': {
    params: { dir: string };
    result: { ok: boolean };
  };
  'fs.unwatch': {
    params: { dir: string };
    result: Empty;
  };
  /** Recent commit history for the Panel's git log (newest first). */
  'workspace.gitLog': {
    params: { dir: string; limit?: number };
    result: { commits: GitLogCommitDTO[] };
  };
  /** Files touched by one commit (git show --name-status). */
  'workspace.commitFiles': {
    params: { dir: string; hash: string };
    result: { files: { status: string; path: string }[] };
  };
  /** Unified diff for one file: against HEAD (working tree, no hash) or as
   *  changed by one commit (hash given). Untracked files diff vs /dev/null.
   *  Image files (png/jpg/gif/webp/bmp/ico/svg) get `image` (before/after
   *  base64 + mime) instead of a text `diff` — either side may be absent
   *  (new/deleted file). */
  'workspace.diff': {
    params: { dir: string; path: string; hash?: string };
    result: {
      diff: string;
      truncated: boolean;
      image?: { before?: string; after?: string; mime: string };
    };
  };
  /** Git remotes (name → fetch URL), origin first. */
  'workspace.remotes': {
    params: { dir: string };
    result: { remotes: { name: string; url: string }[] };
  };
  /** Local branches + the current one ('' = detached HEAD). */
  'workspace.branches': {
    params: { dir: string };
    result: { current: string; branches: string[] };
  };
  /** Switch to a local branch. `err` carries git's message on failure
   *  (dirty tree, unknown branch, …). */
  'workspace.checkout': {
    params: { dir: string; branch: string };
    result: { ok: boolean; err?: string };
  };
  /** Linked worktrees for this repo. */
  'workspace.worktrees': {
    params: { dir: string };
    result: {
      worktrees: {
        path: string;
        head: string;
        branch?: string;
        bare: boolean;
        detached: boolean;
      }[];
    };
  };
  /** Reveal a path in the OS file manager (macOS: Finder `open -R`). */
  'path.reveal': {
    params: { path: string };
    result: { ok: boolean; err?: string };
  };
  /** First candidate path that exists on disk (~ expanded), null if none.
   *  Lets the UI resolve a relative path against several roots — the session
   *  cwd plus the project's attached Files-panel locations — and open the one
   *  that's actually there. */
  'path.firstExisting': {
    params: { paths: string[] };
    result: { path: string | null };
  };
  /** Resolve a reference clicked in the terminal (`src/app.ts`, `notes.md`)
   *  to a file on disk. Tries the agent's reported cwd, the session cwd, the
   *  caller's attached locations, then the session's index of files the agent
   *  has actually opened. Never searches the filesystem: every step is a map
   *  lookup or one existsSync, so a huge repo costs the same as a small one.
   *  `tried` lists where we looked (for an honest "not found"); `candidates`
   *  carries the ambiguous case for the caller to disambiguate. */
  'path.resolve': {
    params: { sessionId: string; ref: string; roots?: string[] };
    result: { path?: string; candidates: string[]; tried: string[] };
  };
  /** Create `<parent>/<name>` for the New-project flow. `name` must be a
   *  single plain segment; an existing directory is reused (`created:false`),
   *  anything else fails with `err`. */
  'path.createDir': {
    params: { parent: string; name: string };
    result: { dir: string | null; created: boolean; err?: string };
  };
  /** Task list. `project` filters to one project dir; omit for ALL tasks
   *  (the "all tasks" view). `status` narrows to open/done. */
  'task.list': {
    params: { project?: string; status?: 'open' | 'done' };
    result: { tasks: TaskDTO[] };
  };
  /** Create a task. Used by the desktop's manual add (source defaults to
   *  'user'); the agent side goes through the `ateam-tasks` MCP server. */
  'task.add': {
    params: {
      title: string;
      body?: string;
      project?: string;
      /** epoch ms for a future reminder */
      remindAt?: number;
      /** up to 3 short labels (project / priority / type / …) */
      tags?: string[];
    };
    result: { task: TaskDTO };
  };
  'task.complete': {
    params: { id: string };
    result: { ok: boolean };
  };
  /** Find where a claude session lives NOW: follows the auto-handoff
   *  successor chain from the given id, prefers a session in the current
   *  tree, falls back to "resumable from disk" (with the owning human from
   *  the session-owners index), else explains why it's gone. `dir` is the
   *  project cwd used to check for the transcript on disk. */
  'session.locate': {
    params: { claudeSessionId: string; dir?: string };
    result: SessionLocation;
  };
  /** Set a project's DISPLAY alias (empty string clears it and the real
   *  directory-derived name shows again). Affects labels only — persistence,
   *  spawn grouping and the per-human project index keep using `name`. */
  'project.setAlias': {
    params: { projectId: string; alias: string };
    result: { ok: boolean };
  };
  /** Extra Files-panel directories for a project scope (the session cwd).
   *  Server-side on purpose: these used to sit in localStorage, which is
   *  per browser, so the desk and the phone each had their own invisible
   *  half of the list. */
  'files.locations': {
    params: { scope: string };
    result: { locations: string[] };
  };
  'files.setLocations': {
    params: { scope: string; locations: string[] };
    result: { locations: string[] };
  };
  'task.reopen': {
    params: { id: string };
    result: { ok: boolean };
  };
  'task.remove': {
    params: { id: string };
    result: { ok: boolean };
  };
  /** Chat mode: the chat list (dm + group), newest first. */
  'chat.list': {
    params: Record<string, never>;
    result: { chats: ChatDTO[] };
  };
  /** Create a chat. A DM (one teammate) defaults to no project directory —
   *  the teammate's desk dir; a group takes the workdir the user picks. */
  'chat.create': {
    params: {
      kind: 'dm' | 'group';
      name: string;
      members: string[];
      workdir?: string;
      purpose?: string;
    };
    result: { chat: ChatDTO };
  };
  'chat.update': {
    params: {
      chatId: string;
      name?: string;
      members?: string[];
      workdir?: string;
      purpose?: string;
    };
    result: { chat: ChatDTO | null };
  };
  'chat.delete': {
    params: { chatId: string };
    result: { ok: boolean };
  };
  /** A chat's messages, oldest→newest; sinceTs (exclusive) for just the new.
   *  `typing` is the teammate (Human id) currently holding the floor — the one
   *  composing a reply — or null; the UI shows their typing dots. */
  'chat.messages': {
    params: { chatId: string; sinceTs?: number };
    result: { messages: ChatMessageDTO[]; typing: string | null };
  };
  /** What a chat has cost so far: the chat-side replies (from the usage
   *  ledger) plus every work session ever spawned for it (from their
   *  transcripts, handoff successors included). Priced per record at the
   *  model's list rate (cache writes 1.25×, cache reads 0.1× input). */
  'chat.usage': {
    params: { chatId: string };
    result: {
      /** every billed token, all four buckets of both sides */
      total: number;
      /** what they bill at list price — the headline */
      costUsd: number;
      chat: ChatUsageBucket;
      work: ChatUsageBucket;
    };
  };
  /** Post the user's message to the chat. Teammates then reply one at a time
   *  (the lead first) through their chat-side one-shot; real work is handed
   *  to their hidden work session. Returns as soon as the message is logged. */
  'chat.send': {
    params: { chatId: string; text: string };
    result: { message: ChatMessageDTO | null };
  };
  /** Open an http(s) URL in the system default browser. */
  'url.open': {
    params: { url: string };
    result: { ok: boolean; err?: string };
  };
  'human.list': {
    params: Empty;
    result: { humans: HumanDTO[] };
  };
  'human.create': {
    params: { name: string; role: string; provider?: string; notes?: string };
    result: { human: HumanDTO };
  };
  'human.get': {
    params: { id: string };
    result: { human: HumanDTO | null };
  };
  /** mutate identity/role/provider/notes — the long-term Human asset is
   *  user-owned, so rename + role-change are explicit user acts (never a
   *  side effect of session.spawn). Returns the new full DTO. */
  'human.update': {
    params: {
      id: string;
      patch: {
        name?: string;
        role?: string;
        provider?: string;
        notes?: string;
        avatarId?: string;
        /** '' clears the binding (back to the runtime's default) */
        model?: string;
        /** what they are responsible for; '' clears it */
        duties?: string;
      };
    };
    result: { human: HumanDTO };
  };
  /** Build a short natural-language summary of the human's accumulated
   *  experiences/skills via headless claude (-p). Best-effort: on CLI
   *  failure returns the existing summary unchanged. Stores result on the
   *  Human (experienceSummary) and returns the updated DTO. */
  'human.summarize': {
    params: { id: string };
    result: { human: HumanDTO };
  };
  /** Unassign a previously-imported skill unit from a Human. Removes the
   *  assignment record and best-effort the per-human skill index/symlink. */
  'skill.unassign': {
    params: { humanId: string; unitPath: string };
    result: { removed: number };
  };
  /** Per-Human meta sweep — distill ≥3 same-domain experiences into Skills
   *  (the flywheel ② transformation), plus a decay pass. The "Reorganize"
   *  button on the Human edit page calls this. */
  'flywheel.distill': {
    params: { humanId: string };
    result: { distilled: number; byDomain: Record<string, number> };
  };
  /** Skill Market items. No params → the offline builtin catalog (back-comat).
   *  With `sourceId` → that source's items, fetched dynamically for remote
   *  marketplaces. `query` searches the full source; `limit` caps the return
   *  (remote sources default to a Top-N slice, search retrieves all). */
  'skill.market.list': {
    params: { sourceId?: string; query?: string; limit?: number };
    result: { items: SkillMarketItem[]; total: number; sourceId: string };
  };
  /** The configured Skill Market sources (builtin + marketplaces). */
  'skill.market.sources': {
    params: Empty;
    result: { sources: MarketSource[] };
  };
  /** Add a marketplace source by owner/repo — validated to expose a
   *  `.claude-plugin/marketplace.json` before it is persisted. */
  'skill.market.addSource': {
    params: { repo: string };
    result: { source: MarketSource };
  };
  'skill.market.removeSource': {
    params: { id: string };
    result: { removed: boolean };
  };
  'skill.market.setSourceEnabled': {
    params: { id: string; enabled: boolean };
    result: { source: MarketSource };
  };
  /** Trigger the LLM web-discovery sweep now (also runs on a 7-day timer):
   *  find new skill marketplaces online, validate them, add as disabled. */
  'skill.market.discover': {
    params: Empty;
    result: { added: MarketSource[] };
  };
  /** Install a market item into a Human's vault (registers via the same
   *  skill.importUnit path so unassign/list work identically). */
  'skill.market.install': {
    params: { humanId: string; itemId: string; sourceId?: string };
    result: { imported: number };
  };
  /** Curated catalog of prefab teammates, grouped by industry + role. */
  'human.market.list': {
    params: Empty;
    result: { items: HumanMarketItem[] };
  };
  /** Hire a prefab teammate into the user's team: create the Human (name/role/
   *  avatar) and install each of its built-in skills. Returns the created
   *  Human plus how many skills were installed. */
  'human.market.hire': {
    params: { itemId: string; name?: string };
    result: { human: HumanDTO; installedSkills: number };
  };
  'config.get': {
    params: Empty;
    result: { firstRun: boolean; config: AteamConfigDTO };
  };
  /** Every prompt the user may edit, with what the app sends now (their
   *  override, or the bundled default) and when it is sent. */
  'prompts.list': {
    params: Empty;
    result: { prompts: PromptInfoDTO[]; overrideDir: string };
  };
  /** Save an override (~/.ateam/prompts/<name>.txt). Applies on the next use.
   *  Placeholders the default relies on but the new text dropped come back as
   *  a warning; saving is not refused for it. */
  'prompts.set': {
    params: { name: string; text: string };
    result: { missingPlaceholders: string[] };
  };
  /** Delete the override — back to the bundled default. */
  'prompts.reset': {
    params: { name: string };
    result: Empty;
  };
  'config.markRole': {
    params: { role: string; skillDir?: string; learnedProject?: string };
    result: Empty;
  };
  'config.finish': {
    params: Empty;
    result: Empty;
  };
  /** Mutate top-level config fields the user can set from Settings.
   *  Only the listed keys are honored; everything else is preserved. */
  'config.set': {
    params: {
      codegraph?: boolean;
      autoResume?: boolean;
      desktopView?: 'terminal' | 'stream';
      autoHandoff?: { enabled?: boolean; thresholdTokens?: number };
      experienceCheckpoint?: { enabled?: boolean; thresholdTokens?: number };
      proxy?: { enabled?: boolean; url?: string };
      hibernate?: { enabled?: boolean; idleHours?: number };
      /** `password` is plaintext in transit (loopback only) and stored as
       *  scrypt hash+salt; enabling with no password ever set is rejected. */
      lan?: { enabled?: boolean; port?: number; password?: string };
      /** self-hosted relay tunnel; `token` is the device bearer secret */
      remote?: {
        enabled?: boolean;
        url?: string;
        deviceId?: string;
        token?: string;
        tlsFingerprint?: string;
      };
    };
    result: { config: AteamConfigDTO };
  };
  /** Live state of the LAN access server (Settings → Remote → LAN). */
  /** Live state of the outbound relay tunnel (Settings → Remote → Remote access). */
  /** Register THIS machine on a relay with account credentials (creates the
   *  account on first use when the relay allows signup). Saves + enables the
   *  remote config on success. Password is used for the one call and never
   *  stored. */
  'remote.register': {
    params: {
      baseUrl: string;
      email: string;
      password: string;
      name: string;
      tlsFingerprint?: string;
      invite?: string;
    };
    result: { deviceId: string; agentUrl: string };
  };
  /** Everything "connect this machine" actually means, as ONE call: register
   *  with the account credentials, turn LAN access on (minting a password when
   *  the user never set one — the tunnel feeds the LAN server and it refuses to
   *  run open), then enable the tunnel. The relay address is built in; only an
   *  email and a password come from the user. Credentials are used for the one
   *  call and never stored.
   *
   *  Ordering matters and is part of the contract: the credentials are checked
   *  FIRST, so a typo cannot leave LAN access switched on behind a failed
   *  sign-in. */
  'remote.signIn': {
    /** `invite`: only for an email with no account yet, on a relay in invite mode */
    params: { email: string; password: string; name?: string; baseUrl?: string; invite?: string };
    result: {
      deviceId: string;
      /** what to open on the phone */
      publicUrl: string;
      /** set only when a LAN password was minted just now — show it once */
      lanPassword?: string;
    };
  };
  /** An invite code another person needs to create a relay account (relay
   *  signup mode 'invite'). Minted for the account this machine signed in with. */
  'remote.createInvite': {
    params: { uses?: number; days?: number };
    result: { code: string; expiresAt: string };
  };
  /** Cross-device sync (docs/sync/client.md). */
  'sync.status': {
    params: Empty;
    result: SyncStatus;
  };
  /** Turn sync on with the account's sync passphrase. The first device of an
   *  account creates the encryption key; every other device must enter the
   *  same passphrase (wrong → error 'bad_passphrase'). Needs a relay sign-in. */
  'sync.enable': {
    params: { passphrase: string };
    result: SyncStatus;
  };
  /** Stop syncing on this device and forget its unlocked key. Local data and
   *  the server copy stay. */
  'sync.disable': {
    params: Empty;
    result: SyncStatus;
  };
  /** Run a sync pass now; resolves when it finishes. */
  'sync.now': {
    params: Empty;
    result: SyncStatus;
  };
  'sync.changePassphrase': {
    params: { current: string; next: string };
    result: Empty;
  };
  'sync.devices': {
    params: Empty;
    result: { devices: SyncDevice[] };
  };
  'sync.renameDevice': {
    params: { id: string; name: string };
    result: Empty;
  };
  /** Revoking a device cuts its tunnel and its sync. Revoking THIS device
   *  signs it out of the relay. */
  'sync.revokeDevice': {
    params: { id: string };
    result: Empty;
  };
  'remote.status': {
    params: Empty;
    result: {
      enabled: boolean;
      connected: boolean;
      clientPort?: number;
      url: string;
      deviceId: string;
      lastError?: string;
      since?: string;
    };
  };
  /** Local web servers this machine could show on a phone — discovered, not
   *  configured: an agent starts the dev server and nobody knows its port. */
  'preview.servers': {
    params: Empty;
    result: {
      servers: { port: number; process: string; host: string; title?: string }[];
    };
  };
  /** Approve ONE discovered port for the relay tunnel. The pick is the
   *  authorization: nothing is reachable from outside until someone who is
   *  already signed in and looking at this machine chooses it. */
  'preview.allow': {
    params: { port: number };
    result: { ok: boolean; port: number; host?: string; err?: string };
  };
  'lan.status': {
    params: Empty;
    result: {
      running: boolean;
      enabled: boolean;
      passwordSet: boolean;
      port: number;
      /** http://<lan-ip>:<port> per non-internal IPv4 interface */
      urls: string[];
      error?: string;
    };
  };
  /** REAL token usage of one session, summed from the claude transcript's
   *  per-request `message.usage` records (what the API actually billed —
   *  unlike usage.recent, which only covers the flywheel's own calls). */
  /** every subscription usage bar we can still show — Claude, ChatGPT (Codex),
   *  and Cursor — not just the focused session's provider. Empty `plans` until
   *  each source has reported at least one live window. */
  'usage.plan': {
    params: { sessionId: string };
    result: {
      plans: {
        providerId: 'claude' | 'codex' | 'cursor';
        windows: { label: string; usedPercent: number; resetsAt: number }[];
        plan?: string;
        updatedAt: number;
      }[];
    };
  };
  'session.usage': {
    params: { sessionId: string };
    result: {
      turns: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      /** list-price USD, each record at its own model's rate */
      costUsd: number;
      /** tokens on a model with no known price (counted, not billed above) */
      unpricedTokens: number;
    };
  };
  /** Cheap estimate of how many tokens the given session has accumulated
   *  in its on-disk transcript. Used by the auto-handoff threshold check;
   *  not a Claude-exact count (no tokenizer is run), but bytes/4 with a
   *  conservative cushion is close enough to flag "approaching the limit". */
  'session.estimateTokens': {
    params: { sessionId: string };
    result: { tokens: number; bytes: number };
  };
  /** Trigger an auto-handoff for the given session: sends Matt Pocock's
   *  handoff skill body to the PTY as a user message so Claude writes the
   *  handoff doc to $TMPDIR. Idempotent per session — repeated calls are
   *  no-ops within a short window. */
  'session.handoffNow': {
    params: {
      sessionId: string;
      focusHint?: string;
      /** runtime for the SUCCESSOR session; defaults to the predecessor's. */
      successorProviderId?: ProviderId;
    };
    result: { triggered: boolean; reason?: string };
  };
  /** Continue the current work on another runtime without calling the old
   *  model. Core exports its local transcript, then the target model reads it
   *  as the first turn. This still works when the source is out of quota. */
  'session.switchProvider': {
    params: { sessionId: string; targetProviderId: ProviderId };
    result: { session: SessionNode; contextPath: string };
  };
  'agent.growth': {
    params: { agentKey: string };
    result: GrowthReport;
  };
  /** Absolute path to a human's knowledge dir (meta.md + skills/knowledge/
   *  experiences), created on demand — the Growth panel's memory browser
   *  points a FilesPane at this instead of a session cwd. */
  'human.metaDir': {
    params: { humanId: string };
    result: { dir: string };
  };
  /** What this human has actually accumulated, read from the LIVE meta
   *  knowledge base (meta.md + the skills/knowledge/experiences trees).
   *  `agent.growth` answers the same question from the FROZEN AssetStore and
   *  therefore reports zero for anyone whose knowledge post-dates the switch
   *  — prefer this for anything user-facing. */
  'human.meta': {
    params: { humanId: string };
    result: {
      index: string;
      indexPath: string;
      entries: { kind: 'skill' | 'knowledge' | 'experience'; name: string; path: string }[];
    };
  };
  'agent.expertise': {
    params: { agentKey: string };
    result: { agentKey: string; domains: DomainExpertise[] };
  };
  /** the token-usage ledger (~/.ateam/token-usage.jsonl) for the GUI */
  'usage.recent': {
    params: { limit?: number };
    result: {
      entries: {
        at: string;
        op: 'reflect' | 'distill' | 'learn';
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
        costUsd?: number;
        detail?: string;
      }[];
      totals: {
        calls: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        costUsd: number;
      };
    };
  };

  /** native apps the user can pick as their "open project dir with" default.
   *  Detection probes /Applications + ~/Applications for known bundles. */
  'app.list': {
    params: Empty;
    result: {
      apps: { id: string; label: string; appName: string; available: boolean }[];
    };
  };
  /** Resolvable app icons (64px PNG base64) keyed by app id. macOS reads
   *  each bundle's .icns; other platforms return {} (UI falls back to a
   *  letter badge). First call converts once, then it's memory-cached. */
  'app.icons': {
    params: Empty;
    result: { icons: Record<string, string> };
  };
  /** open a filesystem path (file or dir) with the chosen app — macOS
   *  `open -a NAME path`. The app decides what to do with files vs dirs.
   *  `path` may be absolute, `~`-prefixed, or relative; if relative AND `cwd`
   *  is given, it resolves against cwd before calling `open` (so terminal
   *  link providers can pass the raw matched text). */
  'app.openPath': {
    params: { appName: string; path: string; cwd?: string };
    result: { ok: boolean; err?: string };
  };
  /** list a directory's immediate children (dirs first, then files). */
  'dir.list': {
    params: { path: string };
    result: {
      path: string;
      /** parent dir, omitted at the filesystem root */
      parent?: string;
      entries: { name: string; path: string; dir: boolean; size: number }[];
    };
  };
  /** Provider-specific slash suggestions. The legacy method name is retained
   *  for compatibility. */
  'claude.commands': {
    params: { sessionId: string };
    result: {
      commands: { name: string; description?: string; source: 'builtin' | 'user' | 'project' }[];
    };
  };
  /** read a file for in-app preview/edit. Text → `text`; images → base64 +
   *  mime; anything else → kind:'unsupported' so the UI falls back to
   *  open-with. Capped in size (see rpc-server). */
  /** an image scaled down for inline display (JPEG); the original when it is
   *  small, animated, or cannot be scaled on this machine */
  'file.thumb': {
    params: { path: string; max?: number };
    result: {
      path: string;
      kind: 'text' | 'image' | 'unsupported';
      base64?: string;
      mime?: string;
      /** bytes of the ORIGINAL file */
      size: number;
      /** true when this is a scaled copy, not the original */
      thumb?: boolean;
    };
  };
  /** what this session's browser tab shows now (JPEG), or null when it has no
   *  tab — never starts a browser */
  'browser.shot': {
    params: { sessionId: string; width?: number };
    result: { base64: string; url: string; title: string; at: number } | null;
  };
  'file.read': {
    params: { path: string };
    result: {
      path: string;
      kind: 'text' | 'image' | 'unsupported';
      text?: string;
      base64?: string;
      mime?: string;
      size: number;
      /** true when a text file was truncated at the read cap. */
      truncated?: boolean;
      /** the text is the END of an oversized log, not its start */
      fromEnd?: boolean;
      /** ISO mtime — shown in the image viewer's info bar */
      mtime?: string;
    };
  };
  'file.videoChunk': {
    params: { path: string; offset: number; length: number; version?: string };
    result: VideoChunkDTO;
  };
  /** overwrite a text file (editor save). */
  'file.write': {
    params: { path: string; text: string };
    result: { ok: boolean; err?: string };
  };
  'provider.list': {
    params: Empty;
    result: {
      providers: {
        id: ProviderId;
        label: string;
        binName: string;
        available: boolean;
        path?: string;
        runtimeSupported: boolean;
      }[];
    };
  };

  /** the shared last-open-session set (~/.ateam/tui-state.json), so the
   *  TUI and the desktop GUI restore the same workspace. */
  'sessionState.get': {
    params: Empty;
    result: { agents: SessionStateAgent[]; focusedClaudeSessionId?: string };
  };
  'sessionState.set': {
    params: { agents: SessionStateAgent[]; focusedClaudeSessionId?: string };
    result: Empty;
  };

  // --- reserved (typed, later milestones) ---
  'project.start': {
    params: { name: string; workspaces: Workspace[]; roles: RoleSpec[]; links?: string[] };
    result: { projectId: string };
  };
}

export interface SkillSourceDTO {
  id: string;
  label: string;
  origin: 'project' | 'global-claude' | 'global-cursor' | 'global-codex';
  path: string;
  kind: 'file' | 'dir';
  count: number;
}

export interface WorkspaceInfoDTO {
  dir: string;
  git: {
    branch: string;
    ahead: number;
    behind: number;
    files: { xy: string; path: string }[];
  } | null;
  tree: { path: string; depth: number; dir: boolean }[];
}

/** A command left running in the background by a session. */
export interface BgShellDTO {
  statusUnknown?: boolean;
  id: string;
  /** false while it is still producing output */
  done: boolean;
  exitCode?: number;
  bytes: number;
  lastAt: string;
  /** first line of output — a glance at what it is doing */
  head: string;
  /** when the command started (its output file's birth), epoch ms */
  startedAtMs?: number;
  /** running only: the last progress figure in its output (`N/M`, `N%`) */
  progress?: {
    done?: number;
    total?: number;
    pct?: number;
    /** tqdm-style: seconds since start, seconds left, items per second */
    elapsedSec?: number;
    etaSec?: number;
    rate?: number;
  };
  /** running only: the last line of output */
  lastLine?: string;
  /** running only: the task's own name (Bash `description`), when it has one */
  label?: string;
  /** a Monitor: a watcher streaming events back to claude, not work of its
   *  own — `lastLine` is its latest event, figures only per source */
  monitor?: boolean;
  /** output interleaving several logs (`path.log: …` lines): a figure per
   *  log, in place of `progress`, which would jump between them */
  sources?: { name: string; progress: NonNullable<BgShellDTO['progress']> }[];
  /** started by this sub-agent (its `SubagentDTO.agentId`) — drawn inside
   *  that agent's row while the agent runs */
  agentId?: string;
}

/** A sub-agent launched by a session (the Agent tool's async agents). */
export interface SubagentDTO {
  agentId: string;
  /** the opening instruction — the closest thing a sub-agent has to a title */
  task: string;
  startedAt: string;
  /** last write to its log; a proxy for "still working" */
  lastAt: string;
  /** it has given its final answer (a later SendMessage makes it run again) */
  done?: boolean;
  /** the Agent call's short name */
  label?: string;
  /** its latest tool call or words */
  activity?: string;
  /** input + cache + output tokens of its latest reply */
  tokens?: number;
}

/** A task / future reminder. The list surface renders ONLY `title`; `body`
 *  (carried paths/context) is delivered to a session on one-click send. */
export interface TaskDTO {
  id: string;
  title: string;
  body?: string;
  status: 'open' | 'done';
  /** absolute project dir (a session cwd); '' = unscoped */
  project: string;
  /** epoch ms; a one-shot reminder fires when reached */
  remindAt?: number;
  reminded?: boolean;
  /** up to 3 short labels, rendered as color-coded chips */
  tags?: string[];
  source: 'agent' | 'user';
  sessionId?: string;
  /** claude session id of the creating session (stable across restarts);
   *  powers the detail modal's "跳转到发起会话". */
  claudeSessionId?: string;
  createdAt: number;
  doneAt?: number;
}

/** A chat (dm/group) as the desktop sees it. Mirrors core's Chat. */
export interface ChatDTO {
  id: string;
  kind: 'dm' | 'group';
  name: string;
  members: string[];
  workdir: string;
  purpose?: string;
  createdAt: number;
}

/** One side of a chat's token bill. */
export interface ChatUsageBucket {
  /** replies (chat side) or turns (work side) */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** list-price USD for those tokens, each record at its own model's rate */
  costUsd: number;
}

/** A single chat message. `from` is a teammate's Human id or 'user'. */
export interface ChatMessageDTO {
  id: string;
  chatId: string;
  from: string;
  kind: 'text' | 'status' | 'result';
  text: string;
  attachments?: { name: string; path: string }[];
  ts: number;
}

/** Where `session.locate` found (or lost) a claude session.
 *  - live: an in-tree session (running or hibernated) — focus it.
 *  - resumable: not in the tree, but the transcript is on disk — offer resume.
 *    `claudeSessionId` is the END of the handoff chain (the newest successor),
 *    which may differ from the id that was asked about.
 *  - gone: the chain dead-ends with no transcript; `reason` says why. */
export type SessionLocation =
  | { kind: 'live'; sessionId: string }
  | { kind: 'resumable'; claudeSessionId: string; dir: string; humanId?: string }
  | { kind: 'gone'; reason: string };

/** One commit in the Panel's git log. */
export interface GitLogCommitDTO {
  hash: string;
  parents: string[];
  /** decorations from %D: 'HEAD -> main', 'origin/main', 'tag: v1.0' … */
  refs: string[];
  subject: string;
  author: string;
  /** iso-strict author date */
  at: string;
}

export interface RecentProjectDTO {
  dir: string;
  source: 'ateam' | 'claude' | 'cursor' | 'codex';
  when: string;
}

/** One curated bundle in the Skill Market. `source` is either a repo-relative
 *  `file:` path (built-in) or an `https:` tar.gz URL (community/optional). */
export interface SkillMarketItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** industry/domain bucket the Skill Market groups by (e.g. 软件研发, 数据).
   *  Optional for back-compat; ungrouped items fall under a catch-all. */
  readonly category?: string;
  readonly tags: string[];
  /** 'file://relative/to/repo' OR 'https://…' (tar.gz) */
  readonly source: string;
  readonly kind: 'file' | 'bundle' | 'tree';
  /** entry file within the unit (e.g. SKILL.md, skill.md, README.md) */
  readonly entry: string;
  /** optional sha256 for HTTPS sources — install rejects on mismatch */
  readonly sha256?: string;
  /** true if this item is built in to the Ateam binary (offline-installable) */
  readonly builtin: boolean;
  /** which MarketSource this item came from ('builtin' or a marketplace id) */
  readonly sourceId?: string;
  /** display author/owner (remote marketplace plugins carry one) */
  readonly author?: string;
  /** remote resolution for marketplace items — the git repo + subdir the
   *  skill lives in; fetched on demand at install time (never pre-bundled). */
  readonly remote?: {
    readonly repoUrl: string;
    readonly ref?: string;
    readonly sha?: string;
    /** plugin subdir within the repo */
    readonly path: string;
  };
}

/** A configured source feeding the Skill Market. `builtin` is the offline
 *  bundled catalog; `marketplace` sources are GitHub repos exposing a
 *  `.claude-plugin/marketplace.json`, fetched dynamically when the user opens
 *  the market. `discovered` marks sources the 7-day LLM sweep found. */
export interface MarketSource {
  readonly id: string;
  readonly name: string;
  readonly kind: 'builtin' | 'marketplace';
  /** owner/repo for marketplace sources */
  readonly repo?: string;
  readonly enabled: boolean;
  /** true if auto-discovered (added disabled; user opts in) */
  readonly discovered?: boolean;
}

/** One prefab teammate in the Human Market. Bundled catalog, grouped by
 *  `industry` then `role`. `skillIds` reference SkillMarketItem ids that are
 *  installed onto the Human when the user hires them into their team. */
export interface HumanMarketItem {
  readonly id: string;
  readonly name: string;
  /** the hat they wear (coder, reviewer, product-manager, …) */
  readonly role: string;
  /** industry bucket the Human Market groups by (e.g. 软件研发) */
  readonly industry: string;
  /** display job title (e.g. 后端工程师) — role is the machine key, this the label */
  readonly title: string;
  readonly description: string;
  readonly tags: string[];
  /** default avatar id (a1…a36) suggested for this prefab */
  readonly avatarId?: string;
  /** SkillMarketItem ids granted on hire */
  readonly skillIds: string[];
}

export interface SkillUnitDTO {
  path: string;
  label: string;
  origin: 'project' | 'global-claude' | 'global-cursor' | 'global-codex';
  kind: 'file' | 'bundle' | 'tree';
  entry: string;
  docCount: number;
  assignedTo: { humanId: string; humanName: string; at: string }[];
}

export interface AteamConfigDTO {
  version: 1;
  roles: Record<string, { skillDir?: string; learnedProjects: string[] }>;
  codegraph: boolean;
  /** restore saved sessions on connect without the confirmation dialog */
  autoResume: boolean;
  /** which view a session opens in on a desktop client (phones: stream) */
  desktopView: 'terminal' | 'stream';
  autoHandoff: { enabled: boolean; thresholdTokens: number };
  /** once per compaction cycle, past this many tokens, a session saves what
   *  it has learned into its knowledge folder and carries on (not replaced) */
  experienceCheckpoint: { enabled: boolean; thresholdTokens: number };
  proxy: { enabled: boolean; url: string };
  hibernate: { enabled: boolean; idleHours: number };
  /** password hash/salt never leave the sidecar — only whether one exists */
  lan: { enabled: boolean; port: number; passwordSet: boolean };
  /** self-hosted relay (token never leaves the core — only whether it is set) */
  remote: {
    enabled: boolean;
    url: string;
    deviceId: string;
    tokenSet: boolean;
    tlsFingerprint: string;
  };
  /** What to call the machine this client is talking to — the name given at
   *  relay registration (the one the phone's machine picker lists), falling
   *  back to the host name. A phone can be pointed at any of several
   *  machines and the UI otherwise gives no clue which one it reached. */
  machineName: string;
}

export interface ExperienceHit {
  id: string;
  agentKey: string;
  scope: 'project' | 'global';
  domain: string;
  title: string;
  lessonLearned: string;
  generalization: string;
  tags: string[];
  appliedCount: number;
  confidence: number;
  score?: number;
}
export interface DomainExpertise {
  domain: string;
  count: number;
  applied: number;
  avgConfidence: number;
  score: number;
  level: 'intermediate' | 'senior' | 'expert';
}
export interface GrowthReport {
  agentKey: string;
  totalExperiences: number;
  domains: DomainExpertise[];
  recent: {
    title: string;
    domain: string;
    createdAt: string;
    appliedCount: number;
    confidence: number;
  }[];
}

export type MethodName = keyof Methods;
export type Params<M extends MethodName> = Methods[M]['params'];
export type Result<M extends MethodName> = Methods[M]['result'];
