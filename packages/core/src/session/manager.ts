import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, type FSWatcher, watch } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  ProjectTree,
  SessionLocation,
  SessionNode,
  SessionState,
  Turn,
  Workspace,
  ExternalRunDTO,
} from '@ateam/contract';
import { asciiPunctuation } from '@ateam/contract';
import { type IPty, spawn as ptySpawn } from 'node-pty';
import { HeldInput, type HoldDeps, deliverHeld, typeIn } from '../server/handoff-hold';
import { loadConfig, proxyEnv } from '../config';
import {
  type CheckpointMark,
  checkpointDecision,
  loadCheckpointMarks,
  saveCheckpointMarks,
} from './checkpoint';
import { findHandoffMarker } from './handoff-marker';
import { estimateTokensFromTranscript } from './token-estimate';
import { ensureHumanMetaDir, knowledgeSizeStatus } from '../human-meta';
import { ensureHuman, getHuman, humanDeskDir, recordHumanProject } from '../humans';
import { ensureProjectMarker, findProjectMarker, recordProjectDir } from '../project-identity';
import { ateamHome } from '../paths';
import { loginShellEnv, mergedPath } from '../platform';
import { stripClaudeProcessMarkers } from './claude-env';
import { getPrompt } from '../prompts';
import { projectAliases, setProjectAlias } from '../project-alias';
import { repoGroup } from '../workspace-info';
import { isRunningAsBackgroundAgent } from './claude-live';
import { codegraphEnabled, ensureCodegraphInit } from './codegraph';
import {
  type HandoffRecord,
  cleanupTakenOverDoc,
  finalizeTakeover,
  getHandoffBySuccessor,
  getHandoffRecord,
  isReusableDoc,
  patchHandoffStatus,
  upsertHandoffRecord,
} from './handoff-state';
import { clearClaudeBridgePointer } from './claude-sessions';
import { ensureClaudeProjectTrusted } from './claude-trust';
import { sessionHookSettings, writeSessionMcpConfig } from './mcp-config';
import { externalReadiness } from './external-readiness';
import {
  type PeerRequest,
  type PeerReply,
  type PeerSession,
  buildPeerEnvelope,
  peerName,
  resolvePeer,
  sweepPeerOutbox,
} from './peers';
import { SessionPathIndex } from './path-index';
import { isDescendantOf } from './proc-ancestry';
import {
  storeCreatedAt,
  storeLastActiveAt,
  storeModel,
  storeResumePath,
  storeTitle,
  storeTranscriptPath,
} from './provider-store';
import { type ProviderId, getAdapter } from './providers';
import {
  continuationPrompt,
  preserveImportedSessionName,
  writeContinuationBundle,
} from './provider-switch';
import { readNativeMigrationMessages } from './native-migration-source';
import { writeCodexSessionImport } from './providers/codex-session-import';
import { writeClaudeSessionImport } from './providers/claude-session-import';
import {
  cursorPromptCount,
  readCursorStreamPage,
  writeCursorSessionImport,
} from './providers/cursor-session-import';
import {
  type CodexProjectionOptions,
  codexResponseCallIds,
  codexResponseOutputIds,
  codexToolSource,
  parseCodexBlocks,
} from './providers/codex-transcript';
import { listCodexSubagents, readCodexSubagentTranscript } from './providers/codex-subagents';
import { listCodexBackground, readCodexBackground } from './providers/codex-background';
import { codexRolloutPath, discoverCodexThread } from './providers/codex-sessions';
import { cursorChatStorePath, discoverCursorChat } from './providers/cursor-sessions';
import { queuedCarryoverBlock, unhandledQueuedMessagesIn } from './queued-carryover';
import { getSessionOwner, recordSessionOwner } from './session-owners';
import {
  type BgProgress,
  commandLabel,
  sessionTask,
  fileSizes,
  outputFiles,
  unannouncedTask,
  writingLine,
  liveTarget,
  progressBySource,
  progressOf,
  redirectTargets,
  taskEnded,
} from './bg-progress';
import { observeProgress, stampedHistory } from './bg-eta';
import { type BgShellInfo, listBackgroundShells, readBackgroundShell } from './bg-shells';
import { copySubagents, runningSubagents, subagentCarryoverBlock } from './subagent-carryover';
import { sessionTasksDir } from './tasks-dir';
import { type SubagentInfo, listSubagents, readSubagentTranscript, tailState } from './subagents';
import { ScreenMirror } from './screen-mirror';
import { Transcript } from './transcript';
import {
  parseTranscriptBlocks,
  parseTranscriptLine,
  readChunk,
  readWindowBefore,
  transcriptPath,
} from './transcript-file';

/** How long an interrupted handoff (prompt injected / doc written, no
 *  successor) is still worth continuing when its session is resumed. The
 *  session is over its context limit either way; past this the doc is
 *  stale and a fresh trigger is better. */
const INTERRUPTED_HANDOFF_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface SpawnArgs {
  projectId?: string;
  projectName?: string;
  agentName: string;
  role: string;
  /** the Human asset; if omitted, derived from {agentName, role} */
  human?: { id?: string; name: string; role: string; provider?: string };
  /** omit (or set directoryless) for a directory-less "talk to a human"
   *  session — the agent navigates projects itself via Bash `cd`. */
  workspace?: Workspace;
  directoryless?: boolean;
  /** if set, resume this Claude Code session (`claude --resume <id>`) */
  resumeSessionId?: string;
  /** which agent-CLI runtime drives this session. Defaults to claude (the
   *  only runtime fully wired today; codex/opencode adapters throw). */
  providerId?: ProviderId;
  /** Explicit session display name (claude --name). Auto-handoff passes
   *  the predecessor's current title here so the successor keeps the name
   *  the user knows instead of resetting to the project name. */
  sessionName?: string;
  /** Extra text appended to the recall-derived system prompt for this
   *  spawn only — used by auto-handoff to brief the successor session
   *  with the handoff document. */
  extraSystemPrompt?: string;
  /** when this session is the backing worker for a chat, its id + the
   *  teammate's Human id so the `ateam-chat` MCP is mounted with that scope */
  chat?: { chatId: string; humanId: string };
  /** An initial user message claude submits as its FIRST turn (trailing
   *  positional prompt). Used by auto-handoff to hand the successor the
   *  handoff doc reliably — claude submits it itself once its TUI is ready,
   *  instead of us racing a bracketed-paste into a booting TUI. */
  initialPrompt?: string;
  /** initial PTY size (size to the destination pane up front) */
  cols?: number;
  rows?: number;
  /** Resume by branching a copy (claude --fork-session) instead of re-opening
   *  the conversation in place. The only way into a conversation that is
   *  already running as a background agent — asked for explicitly, never
   *  inferred, since it leaves the original running alongside the copy. */
  forkSession?: boolean;
}

/**
 * Whether a live session has been quiet long enough to hibernate.
 *
 * Two clocks, and the newer one wins. `recordedIso` is the transcript's last
 * real record — the authority on work done, but written only when a turn
 * completes, so it lags. `activeAt` is what this process saw: the spawn or
 * wake, a keystroke, a resize. A session you just woke still carries the
 * records it had when it went to sleep, so on the transcript alone it looks
 * idle the instant it comes back and the next sweep puts it under while you
 * are mid-sentence — which is exactly the bug this exists to prevent.
 *
 * A session with neither clock (brand new, nothing written yet) is left alone.
 */
export function isIdleForHibernation(
  recordedIso: string,
  activeAt: number,
  cutoff: number,
): boolean {
  const recorded = Date.parse(recordedIso);
  const hasRecord = !Number.isNaN(recorded);
  if (!hasRecord && !activeAt) return false;
  return Math.max(hasRecord ? recorded : 0, activeAt) <= cutoff;
}

/** Closest ancestor of `dir` that exists — the useful half of a "that path is
 *  gone" message, since it shows how far up the tree the survivor is. */
function nearestExistingDir(dir: string): string | undefined {
  let cur = dir;
  for (let i = 0; i < 16; i++) {
    const parent = cur.slice(0, cur.lastIndexOf('/'));
    if (!parent || parent === cur) return undefined;
    if (existsSync(parent)) return parent;
    cur = parent;
  }
  return undefined;
}

/** submitWhenRead: the TUI has settled once it has printed nothing this long */
const SUBMIT_QUIET_MS = 80;
/** ...or, if it keeps printing (a spinner mid-turn), this long after it first
 *  answered the text — it is plainly reading its input by then */
const SUBMIT_BUSY_MS = 300;
const SUBMIT_POLL_MS = 25;
/** a TUI that never echoes still gets its Enter, just late */
const SUBMIT_MAX_WAIT_MS = 5000;
/** handoff documents are commonly around 40KB; keep the live card complete */
const HANDOFF_TURN_EVENT_CAP = 42_000;

interface Session {
  node: Omit<SessionNode, 'state'>;
  /** absent while hibernated — the claude process is gone, the node stays */
  pty?: IPty;
  /** Pacing for the submit-Enter (see submitWhenRead): when text was last
   *  written to the PTY, and when the TUI first answered it with output. */
  typedAt?: number;
  echoAt?: number;
  /** the last Enter we wrote (a manual turn may not have reached the transcript yet) */
  submittedAt?: number;
  /** what the CLI's screen shows — external delivery waits while a dialog is up */
  screen?: ScreenMirror;
  lastOutputAt?: number;
  /** input that arrived while an Enter was held back — it goes AFTER it */
  afterSubmit?: string[];
  /** When this session was last demonstrably in use, in THIS process: spawned,
   *  woken, typed into, or resized. The hibernate sweep needs it because the
   *  transcript — its only other evidence — is written lazily: a session you
   *  just woke and are typing into still carries hours-old records, so a sweep
   *  keyed on the transcript alone would put it straight back to sleep
   *  mid-sentence. */
  activeAt: number;
  transcript: Transcript;
  state: SessionState;
  /** last size this session's pane reported; survives hibernation so wake()
   *  resumes claude at the width it was last drawn at */
  cols?: number;
  rows?: number;
  /** absolute paths this agent has touched, harvested from its transcript —
   *  how a relative path printed in the terminal gets resolved without
   *  searching the filesystem (see path-index.ts) */
  pathIndex?: SessionPathIndex;
  codexProjection?: {
    path: string;
    toolSource: CodexProjectionOptions['toolSource'];
    responseCallIds: Set<string>;
    responseOutputIds: Set<string>;
  };
}

/**
 * Spawns one interactive `claude` CLI per agent in its workspace cwd; same
 * project -> multiple agents -> different directories, concurrently. Emits
 * `output` / `status` / `turn`. Also the programmatic seam the flywheel hooks
 * (M2) via `transcript()`.
 */
/** A sub-agent's task is over once the agent has said its last word and the
 *  task has written nothing since. */
function ownerFinished(agentLog: string | undefined, taskLastAt: string): boolean {
  if (!agentLog) return false;
  try {
    return tailState(agentLog).done && Date.parse(taskLastAt) <= statSync(agentLog).mtimeMs;
  } catch {
    return false;
  }
}

/** `…/subagents/agent-<id>.jsonl` → `<id>` */
function agentIdOfLog(log: string | undefined): string | undefined {
  const m = log ? /agent-([^/]+)\.jsonl$/.exec(log) : null;
  return m?.[1];
}

/** when a task's output file was created — the command's start */
function taskBornAt(cwd: string, claudeSessionId: string, id: string): number | undefined {
  try {
    const b = statSync(join(sessionTasksDir(cwd, claudeSessionId), `${id}.output`)).birthtimeMs;
    return b > 0 ? b : undefined;
  } catch {
    return undefined;
  }
}

function writeNativeSessionImport(
  targetProviderId: ProviderId,
  messages: ReturnType<typeof readNativeMigrationMessages>,
  cwd: string,
) {
  if (targetProviderId === 'codex') return writeCodexSessionImport(messages, cwd);
  if (targetProviderId === 'cursor') return writeCursorSessionImport(messages, cwd);
  return writeClaudeSessionImport(messages, cwd);
}

export class SessionManager extends EventEmitter {
  constructor() {
    super();
    // idle-session sweep: a live claude process costs ~300MB whether or not
    // anyone talks to it. Every 10 minutes, sessions whose transcript has
    // been quiet longer than config.hibernate.idleHours get their PTY
    // killed (the node stays; clicking wakes it via --resume).
    const t = setInterval(() => this.hibernateSweep(), 10 * 60_000);
    t.unref();
    // experience checkpoint: see checkpoint.ts
    const c = setInterval(() => this.checkpointSweep(), 30_000);
    c.unref();
    this.watchSessionLinks();
    this.watchPeerOutbox();
    this.on('replaced', (ev: { oldSessionId: string; newSessionId: string }) => {
      const held = this.heldInput.get(ev.oldSessionId);
      this.heldInput.delete(ev.oldSessionId);
      if (held) deliverHeld(held, ev.newSessionId, this.holdDeps);
    });
  }

  /** last time the person sent input to a session — a checkpoint must not be
   *  pasted into the terminal's input box while they are writing in it */
  private readonly lastInputAt = new Map<string, number>();
  /** claudeSessionId → where this compaction cycle's checkpoint fired */
  private checkpointMarks: Map<string, CheckpointMark> | undefined;

  /** Tell each session past the checkpoint threshold, once per compaction
   *  cycle, to write down what it has learned — before Claude Code's own
   *  compaction summarizes it away. Every live claude session with a
   *  teammate, focused or not, on any device. */
  private checkpointSweep(): void {
    const { experienceCheckpoint: cfg } = loadConfig();
    if (!cfg.enabled) return;
    this.checkpointMarks ??= loadCheckpointMarks();
    const marks = this.checkpointMarks;
    let changed = false;
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.state !== 'running' || !s.pty) continue;
      if ((s.node.providerId ?? 'claude') !== 'claude' || !s.node.humanId) continue;
      const cid = s.node.claudeSessionId;
      if (!cid) continue;
      const path = transcriptPath(s.node.cwd, cid);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue; // no transcript yet
      }
      const { tokens, estimated } = estimateTokensFromTranscript(s.node.cwd, cid);
      // a guess from the file's size is no reason to interrupt anyone
      if (estimated) continue;
      const decision = checkpointDecision({
        tokens,
        threshold: cfg.thresholdTokens,
        mark: marks.get(cid),
        transcriptQuietMs: now - mtimeMs,
        inputQuietMs: now - (this.lastInputAt.get(id) ?? 0),
        handoffInFlight: this.handoffPendingSince.has(id),
      });
      if (decision === 'rearm') {
        marks.delete(cid);
        changed = true;
        continue;
      }
      if (decision !== 'fire') continue;
      const body = getPrompt('checkpoint', {
        TOKENS: tokens.toLocaleString('en-US'),
        META_DIR: ensureHumanMetaDir(s.node.humanId),
        SIZE_STATUS: knowledgeSizeStatus(s.node.humanId),
      });
      // the same two-phase write as a hand-off: the paste, then the Enter
      // once the TUI has committed it (in one write the Enter is eaten as
      // part of the paste and the message sits unsent)
      this.typeInto(s, `\x1b[200~${body}\x1b[201~`);
      setTimeout(() => this.submitWhenRead(s), 150);
      marks.set(cid, { tokens, at: new Date(now).toISOString() });
      changed = true;
    }
    if (changed) saveCheckpointMarks(marks);
  }

  private sessionLinksWatcher?: FSWatcher;
  private peerWatcher?: FSWatcher;
  private peerSweepTimer?: ReturnType<typeof setInterval>;

  private watchPeerOutbox(): void {
    const home = ateamHome();
    const sweep = (): void => {
      try {
        sweepPeerOutbox(home, (request) => this.handlePeerRequest(request));
      } catch {
        /* A transient filesystem failure is retried by the periodic sweep. */
      }
    };
    sweep();
    try {
      this.peerWatcher = watch(join(home, 'peer-outbox'), (_event, file) => {
        if (!file || (file.endsWith('.json') && !file.endsWith('.reply.json'))) sweep();
      });
      this.peerWatcher.on('error', () => this.peerWatcher?.close());
      this.peerWatcher.unref();
    } catch {
      /* The sweep also covers filesystems without directory watches. */
    }
    this.peerSweepTimer = setInterval(sweep, 1000);
    this.peerSweepTimer.unref();
  }

  /** External MCP uses the same live-session inventory and input owner. */
  externalReply?: (sender: PeerSession, address: string, message: string) => void;

  /** Linked standalone command history for a runtime session. Filled by sidecar. */
  externalRuns?: (sessionId: string) => ExternalRunDTO[];

  listPeerSessions(): PeerSession[] {
    const visible = new Map(
      this.list()
        .flatMap((p) => p.sessions)
        .map((s) => [s.sessionId, s]),
    );
    const peers: PeerSession[] = [...this.sessions.values()].map((s) => {
      const node = visible.get(s.node.sessionId) ?? this.toNode(s);
      const inputStatus = this.externalInputState(s);
      return {
        id: node.sessionId,
        name: peerName(node),
        provider: node.providerId ?? 'claude',
        projectDir: node.cwd,
        model: node.model ?? '',
        input_status: inputStatus,
        state: !s.pty || s.state === 'exited' ? 'exited' : inputStatus === 'ready' ? 'idle' : 'working',
        ...(s.node.claudeSessionId ? { stable_id: s.node.claudeSessionId } : {}),
        ...(s.node.humanId ? { human_id: s.node.humanId, human_name: s.node.humanName ?? '' } : {}),
      };
    });
    return peers;
  }

  /** Paste and submit at once — a busy CLI queues the message itself. Held back
   *  only while a dialog is on screen, where the Enter would answer it. */
  deliverExternalMessage(sessionId: string, envelope: string): boolean {
    const s = this.require(sessionId);
    if (!s.pty || s.state === 'exited') throw new Error('session_unavailable');
    if (this.dialogOnScreen(s)) return false;
    this.input(sessionId, `\x1b[200~${envelope}\x1b[201~`);
    this.input(sessionId, '\r');
    this.verifyExternalLanding(s, envelope);
    return true;
  }

  /** A paste whose Enter was swallowed sits in the TUI box until some later turn
   *  boundary flushes it. Check the transcript; if the message never landed,
   *  press Enter once more (a no-op on an empty box). */
  private verifyExternalLanding(s: Session, envelope: string): void {
    const address = /from="(external:[^"]+)"/.exec(envelope)?.[1];
    if (!address) return;
    let nudged = false;
    const check = (attempt: number): void => {
      if (this.sessions.get(s.node.sessionId) !== s || !s.pty) return;
      const provider = s.node.providerId ?? 'claude';
      const path = storeTranscriptPath(provider, s.node.cwd, s.node.claudeSessionId);
      let landed = false;
      try {
        landed = !!path && readChunk(path, 256 * 1024, true).some((l) => l.includes(address));
      } catch {
        /* unreadable: treat as not landed */
      }
      // A busy CLI holds the message in its own queue until the turn ends, so keep
      // looking for a while; press Enter again only on an idle CLI with no dialog,
      // where a box still holding the paste means the Enter was swallowed.
      if (landed || attempt >= 40) return;
      if (!nudged && attempt >= 1 && this.externalInputState(s) === 'ready' && pasteInBox(s)) {
        nudged = true;
        this.input(s.node.sessionId, '\r');
      }
      setTimeout(() => check(attempt + 1), 8000);
    };
    setTimeout(() => check(0), 8000);
  }

  /** A dialog (permission prompt, menu) is up, or output is still being parsed. */
  private dialogOnScreen(s: Session): boolean {
    return !!s.screen && (s.screen.settling || s.screen.dialogVisible());
  }

  private externalInputState(s: Session): 'ready' | 'busy' | 'unknown' {
    if (!s.pty || s.state === 'exited') return 'unknown';
    if (this.isHandingOff(s.node.sessionId) || s.afterSubmit || this.dialogOnScreen(s))
      return 'busy';
    const provider = s.node.providerId ?? 'claude';
    const path = storeTranscriptPath(provider, s.node.cwd, s.node.claudeSessionId);
    if (!path) return 'unknown';
    // A submitted manual turn may not yet have reached the provider's transcript.
    try {
      const submitted = s.submittedAt ?? 0;
      if (submitted > statSync(path).mtimeMs && Date.now() - submitted < 30_000) return 'busy';
    } catch { return 'unknown'; }
    return externalReadiness(provider, readChunk(path, 128 * 1024, true));
  }

  handlePeerRequest(request: PeerRequest): PeerReply {
    const peers = this.listPeerSessions();
    const sender = peers.find((s) => s.id === request.from && s.state !== 'exited');
    if (!sender) throw new Error('Sender session is not running.');
    if (request.kind === 'list')
      return {
        ok: true,
        sessions: peers
          .filter((s) => s.id !== sender.id && s.state !== 'exited')
          .map(({ stable_id: _stable, human_id: _human, ...s }) => ({ ...s, id: s.id.slice(0, 8) })),
      };
    if (request.to.startsWith('external:')) {
      if (!this.externalReply) throw new Error('External MCP is disabled.');
      this.externalReply(sender, request.to, request.message);
      return { ok: true, message: 'Reply saved for external MCP client.' };
    }
    const target = resolvePeer(peers, sender.id, request.to);
    if (target.state === 'exited') throw new Error(`Session ${target.name} is not running.`);
    this.input(target.id, `\x1b[200~${buildPeerEnvelope(sender, request.message)}\x1b[201~`);
    this.input(target.id, '\r');
    return { ok: true, message: `Message sent to ${target.name}.` };
  }

  /** Watch `<ateamHome>/session-links/`. The per-session SessionStart hook
   *  (session-hook.cjs) drops `<ateamSessionId>.json` there carrying claude's
   *  CURRENT session id; when `/clear` rotates that id, we follow it. */
  private watchSessionLinks(): void {
    const dir = join(ateamHome(), 'session-links');
    try {
      mkdirSync(dir, { recursive: true });
      let deb: ReturnType<typeof setTimeout> | undefined;
      this.sessionLinksWatcher = watch(dir, (_ev, fn) => {
        if (!fn || !fn.endsWith('.json')) return;
        clearTimeout(deb);
        deb = setTimeout(() => this.readSessionLink(dir, fn as string), 100);
      });
      this.sessionLinksWatcher.on('error', () => this.sessionLinksWatcher?.close());
      this.sessionLinksWatcher.unref?.();
    } catch {
      /* fs.watch unsupported here — /clear following is simply off */
    }
  }

  private readSessionLink(dir: string, file: string): void {
    const ateamSessionId = file.replace(/\.json$/, '');
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
        claudeSessionId?: string;
        pid?: number;
        ppid?: number;
        source?: string;
      };
      if (!raw.claudeSessionId) return;
      // A report is only believed from inside this session's own PTY tree.
      // Anything that forks the conversation inherits ATEAM_SESSION and the
      // hook, so without this an outside fork — the Claude app's background
      // agents do exactly this — silently re-points the row at a session
      // Ateam does not own and cannot resume (2026-09-10).
      // Reports with no pid come from an older hook: trusted, as before.
      if (raw.pid !== undefined) {
        const ptyPid = this.sessions.get(ateamSessionId)?.pty?.pid;
        if (!isDescendantOf(raw.ppid ?? raw.pid, ptyPid)) {
          // Leave a trace: if this check ever refuses a report it SHOULD have
          // taken, the row silently stops following /clear, and without this
          // line there is nothing to find. `session-links/rejected.log`.
          try {
            appendFileSync(
              join(dir, 'rejected.log'),
              `${new Date().toISOString()} ${ateamSessionId} source=${raw.source ?? '?'} reporter=${raw.pid}/${raw.ppid} ptyPid=${ptyPid ?? 'none'} claimed=${raw.claudeSessionId}\n`,
            );
          } catch {
            /* best-effort */
          }
          return;
        }
      }
      this.linkClaudeSession(ateamSessionId, raw.claudeSessionId);
    } catch {
      /* torn / partial write — the next event re-reads it */
    }
  }

  /** Follow a claude session-id rotation (e.g. after `/clear`): re-point the
   *  turn watcher + tracked id to the new transcript so activity, resume and
   *  the active-window filter all track the LIVE conversation. No-op when the
   *  id is unchanged (startup/resume reporting the same id) or unknown. */
  private linkClaudeSession(ateamSessionId: string, claudeSessionId: string): void {
    const s = this.sessions.get(ateamSessionId);
    if (!s || s.node.claudeSessionId === claudeSessionId) return;
    const prevId = s.node.claudeSessionId;
    // A fresh Cursor chat has no store until the CLI creates one. The first
    // watch is unbound, so the history written before we learn the id must
    // still be emitted. A resume already had a path and must not replay.
    const cursorWasUnbound =
      s.node.providerId === 'cursor' && !this.turnWatch.get(ateamSessionId)?.path;
    this.stopTurnWatch(ateamSessionId);
    s.node = { ...s.node, claudeSessionId };
    // if this session is a handoff successor, keep the chain pointing at the
    // LIVE id (locate() follows successorClaudeSessionId; crash-recovery
    // looks the record up by it).
    const rec = getHandoffBySuccessor(prevId);
    if (rec)
      patchHandoffStatus(rec.oldClaudeSessionId, { successorClaudeSessionId: claudeSessionId });
    if (s.pty) this.startTurnWatch(ateamSessionId, s.node.cwd, claudeSessionId);
    if (cursorWasUnbound) {
      const watch = this.turnWatch.get(ateamSessionId);
      if (watch) watch.cursorSeen = 0;
    }
    // /clear rotates to a brand-new claude session id — keep the owner
    // index current so a later Resume still shows this human, not "unknown".
    recordSessionOwner(claudeSessionId, s.node.humanId);
    this.emit('status', { sessionId: ateamSessionId, state: s.state });
  }

  private readonly sessions = new Map<string, Session>();
  private readonly projectNames = new Map<string, string>();
  /** Last pane size any client reported (see resize()). The sidecar is spawned
   *  with pipes, so `process.stdout.columns` is undefined and every PTY used to
   *  start at the 120×32 fallback: claude painted its banner at 120 columns,
   *  the pane's first fit resized it, and claude repainted — leaving the stale
   *  narrow frame in the scrollback as a mangled duplicate (very visible when
   *  switching projects, which wakes a session and boots a fresh claude). */
  private lastViewport?: { cols: number; rows: number };
  // last time we wrote a handoff prompt to a session — guard against
  // double-firing if the UI poll sees the threshold crossed twice in a row.
  private readonly lastHandoffAt = new Map<string, number>();
  /** sessions whose handoff is being written RIGHT NOW (prompt injected,
   *  successor not spawned). Served through list() so every client — a
   *  phone connecting mid-handoff included — renders the handoff overlay.
   *  Freshness-capped to mirror the UI's own 10-minute safety cap. */
  private readonly handoffPendingSince = new Map<string, number>();
  /** Per-session output watcher state. Armed when handoff prompt is
   *  injected; on each chunk we look for "handoff written: <path>" in a
   *  small rolling window. Match → read the file, spawn successor, emit
   *  session.replaced, disarm. */
  private readonly handoffWatch = new Map<
    string,
    {
      window: string;
      spawnTemplate: SpawnArgs;
      /** ms timestamp of the last keystroke we sent at the menu. We retry
       *  every 1.5s while the menu is still visible — claude TUI's menu
       *  mode (no input box, "Esc to cancel · Tab to amend" footer) may
       *  not accept the same keystroke we use in normal input mode, so we
       *  cycle through `1\r`, `\r`, `\n` until the menu disappears. */
      lastMenuAttemptAt?: number;
      /** Number of attempts so far for the CURRENT visible menu. Reset
       *  to 0 once the menu pattern drops out of the window. */
      menuAttempts?: number;
    }
  >();
  /** Tail-watcher over each session's on-disk claude transcript jsonl.
   *  The PTY stream repaints constantly (usage-limit banners, update
   *  notices, spinner/status redraws) so it CANNOT distinguish "new
   *  message" from "cosmetic redraw" — the transcript file only grows
   *  when a real record lands. We poll the file size and emit a `turn`
   *  event per newly appended record; the UI keys its unread dot and
   *  system notifications off these. */
  private readonly turnWatch = new Map<
    string,
    {
      timer: ReturnType<typeof setInterval>;
      /** fires the moment the transcript changes; the timer is the fallback */
      watcher?: FSWatcher;
      path: string;
      offset: number;
      seq: number;
      /** Cursor only: prompt blobs already reflected in the stream. A resumed
       * chat starts at the current count so history is not replayed. */
      cursorSeen?: number;
      /** Cursor only: `store.db` + WAL size/mtime. WAL writes often leave the
       * main file's size unchanged. */
      mark?: string;
      /** ms timestamp of the last observed transcript growth — the handoff
       *  idle gate. PTY bytes CANNOT serve here: claude's TUI repaints even
       *  at rest (spinner shimmer, token meter), so "quiet PTY" never
       *  happens and a PTY-based gate rejects forever. The transcript only
       *  grows when a real record lands. */
      lastAppendAt: number;
    }
  >();
  /** ⑦ recall: returns memory to inject as claude --append-system-prompt.
   *  Keyed by the Human id (the long-term asset), not the role. For a
   *  directory-less session it also injects the human's known project dirs
   *  so the agent can `cd` into the right one on its own. */
  private recallFn?: (
    humanId: string,
    cwd: string,
    opts?: { directoryless?: boolean },
  ) => string | undefined;

  setRecall(
    fn: (humanId: string, cwd: string, opts?: { directoryless?: boolean }) => string | undefined,
  ): void {
    this.recallFn = fn;
  }

  get(sessionId: string): SessionNode | undefined {
    const s = this.sessions.get(sessionId);
    return s ? this.toNode(s) : undefined;
  }

  spawn(args: SpawnArgs): SessionNode {
    const sessionId = randomUUID();
    // resolve / create the long-term Human first (directory-less sessions
    // derive their cwd from the human, so we need its id up front).
    const human = ensureHuman(args.human ?? { name: args.agentName, role: args.role });
    const directoryless = args.directoryless === true || !args.workspace;
    const cwd = directoryless ? humanDeskDir(human.id) : (args.workspace as Workspace).root;
    const workspaceId = directoryless ? 'direct' : (args.workspace as Workspace).id;
    const providerId: ProviderId = args.providerId ?? 'claude';

    // A workspace whose directory has since been moved or deleted produces the
    // most baffling failure this app can show: node-pty forks happily, the
    // child's chdir fails, and the agent dies with exit 1 and ZERO output — an
    // empty terminal and a dead tombstone with nothing to explain it (a repo
    // reorganised under a still-remembered path does exactly this). Fail at the
    // call instead, naming the nearest directory that does still exist so the
    // user can see what moved. Directory-less sessions are exempt: their desk
    // dir is created on demand.
    // Resume dedup: two clients can both answer the restore prompt (a phone
    // joining while the desktop's dialog sits unanswered gets the SAME saved
    // list from sessionState.get), and auto-resume makes every connecting
    // client ask. Spawning twice would run two claude processes on one
    // conversation — return the live session instead, it IS what was asked
    // for. Exited/replaced rows don't count: those are legitimately
    // respawnable tombstones.
    if (args.resumeSessionId) {
      for (const existing of this.sessions.values()) {
        if (
          (existing.node.providerId ?? 'claude') === providerId &&
          existing.node.claudeSessionId === args.resumeSessionId &&
          existing.state !== 'exited' &&
          !existing.node.replacedBySessionId
        ) {
          // hibernated → wake it (that's what "resume" means here); a
          // bg_agent_running refusal propagates like it does from wake().
          if (existing.state === 'hibernated') return this.wake(existing.node.sessionId);
          return this.toNode(existing);
        }
      }
    }

    if (!directoryless && !existsSync(cwd)) {
      const near = nearestExistingDir(cwd);
      const err = new Error(
        `workspace directory no longer exists: ${cwd}` +
          (near ? ` — nearest existing directory is ${near}` : ''),
      ) as Error & { code?: string };
      err.code = 'cwd_missing';
      throw err;
    }

    // Group sessions by project NAME: if a project with the same name already
    // exists in this run, reuse its id so the tree aggregates correctly even
    // when the client (GUI) doesn't track project-id-by-name itself.
    let projectId = args.projectId;
    if (!projectId && args.projectName) {
      for (const [id, name] of this.projectNames) {
        if (name === args.projectName) {
          projectId = id;
          break;
        }
      }
    }
    projectId ??= randomUUID();
    const projectName =
      args.projectName ??
      this.projectNames.get(projectId) ??
      (directoryless ? human.name : 'project');
    this.projectNames.set(projectId, projectName);

    // a directory-less session has no project to record participation in;
    // the agent `cd`s into real dirs itself and we never auto-claim them.
    if (!directoryless) recordHumanProject(human.id, cwd, this.projectIdentity(cwd, projectName));
    // Every agent gets a stable session id we control, so the TUI/GUI can
    // persist it and resume the exact conversation later. The id is
    // claude-Code-flavored (UUID) — keeps the existing field name even
    // when the underlying runtime is codex/opencode, since adapters map it.
    const claudeSessionId = args.resumeSessionId ?? randomUUID();
    // Durable claudeSessionId -> humanId index (session-owners.ts) so a
    // later Resume-modal listing (which only sees a raw ~/.claude transcript,
    // no Ateam context) can show the right avatar and reuse this human.
    recordSessionOwner(claudeSessionId, human.id);
    // Resume only works if claude actually has a transcript for that id.
    // A session id can be persisted (and asked to resume) WITHOUT an
    // on-disk transcript — e.g. an auto-handoff successor that was spawned
    // but never completed a turn before the app closed (claude writes the
    // .jsonl lazily on the first turn). `claude --resume <missing>` exits
    // with "No conversation found" → a dead exited(1) tombstone. Instead,
    // fall back to a FRESH session that REUSES the same id: claude writes a
    // new transcript at that id, persistence stays stable, future restores
    // work. Only resume when the transcript genuinely exists.
    const resumePath = args.resumeSessionId
      ? storeResumePath(providerId, cwd, args.resumeSessionId)
      : '';
    const resumeSessionId =
      args.resumeSessionId && resumePath && existsSync(resumePath)
        ? args.resumeSessionId
        : undefined;
    // First-turn message claude submits itself (trailing positional prompt).
    // Two sources:
    //   1. explicit (auto-handoff spawning a fresh successor), and
    //   2. crash-during-handoff recovery: we're resuming a session id that is
    //      a known handoff successor which never finished its first turn (no
    //      transcript) — the process died mid-handoff. We're now a fresh
    //      session reusing that id (resumeSessionId fell back to undefined);
    //      re-deliver the surviving handoff doc so the takeover completes.
    //      If the transcript DOES exist, the successor already took over on a
    //      prior run → the doc has done its job → clean it up.
    let initialPrompt = args.initialPrompt;
    if (!initialPrompt && args.resumeSessionId) {
      const rec = getHandoffBySuccessor(args.resumeSessionId);
      if (rec) {
        if (resumeSessionId) {
          cleanupTakenOverDoc(rec.oldClaudeSessionId);
        } else if (rec.handoffPath && existsSync(rec.handoffPath)) {
          initialPrompt = this.buildHandoffMessage(rec.handoffPath);
        }
      }
    }
    // The other interrupted case: THIS session was mid-handoff when the app
    // quit — the prompt was injected (pending) or the doc was even written
    // (doc_ready), but no successor came up. Resuming it as if nothing
    // happened leaves the user with a session over its context limit and a
    // handoff that silently evaporated (seen 2026-09-07: an app restart
    // landed 4 minutes after the prompt, before claude had answered a word).
    // Continue it instead: with a fresh doc the successor is spawned right
    // after boot; without one the handoff prompt goes in as the first user
    // message — claude submits it itself once its TUI is ready, so it cannot
    // be lost to the boot race a paste would hit.
    let resumeHandoff: HandoffRecord | undefined;
    if (!initialPrompt && resumeSessionId && args.forkSession !== true) {
      const rec = getHandoffRecord(resumeSessionId);
      const age = rec ? Date.now() - Date.parse(rec.triggeredAt) : Number.POSITIVE_INFINITY;
      if (
        rec &&
        (rec.status === 'pending' || rec.status === 'doc_ready') &&
        age < INTERRUPTED_HANDOFF_MAX_AGE_MS
      ) {
        resumeHandoff = rec;
        if (!isReusableDoc(rec)) {
          initialPrompt = getPrompt('handoff', {
            FOCUS_HINT:
              'Your previous attempt at this handoff was cut short by an app restart — write the document now, before anything else.',
            META_DIR: ensureHumanMetaDir(human.id),
            SIZE_STATUS: knowledgeSizeStatus(human.id),
          });
        }
      }
    }
    const sessionName = (
      args.sessionName?.trim() ||
      (directoryless ? human.name : args.projectName?.trim() || basename(cwd) || 'session')
    ).slice(0, 40);
    // MCP servers handed to the session over --mcp-config: ateam-tasks
    // (always, scoped to this project) + per-workspace CodeGraph (when
    // enabled). One combined config so both coexist.
    if (codegraphEnabled()) ensureCodegraphInit(cwd);
    const mcpConfigPath = writeSessionMcpConfig(sessionId, cwd, args.chat);
    // ⑦ recall: the Human's accumulated memory. Claude gets it via
    // --append-system-prompt; Codex via developer_instructions; Cursor folds
    // it into the positional initial prompt (stream hides the wrapper tag).
    // When codegraph is wired in, a usage nudge follows — without it claude
    // ignores the MCP tools and greps out of habit. extraSystemPrompt (the
    // auto-handoff successor's doc) comes last.
    const recalled = this.recallFn?.(human.id, cwd, { directoryless }) ?? '';
    const appendSystemPrompt = [
      recalled,
      codegraphEnabled() && !directoryless ? getPrompt('codegraphHint') : '',
      args.extraSystemPrompt ?? '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const adapter = getAdapter(providerId);
    const bin = adapter.resolveBin();
    // Pre-accept Claude's workspace-trust dialog for this cwd. A chat
    // teammate's session is hidden, so it could never answer the prompt and
    // would hang forever on a directory Claude has not seen before — including
    // a DM's desk dir, so this runs for directory-less sessions too.
    if (providerId === 'claude') {
      ensureClaudeProjectTrusted(cwd);
      // Project-level, not per session. A fresh launch and a --resume both
      // pick this pointer up if it is still here.
      clearClaudeBridgePointer(cwd);
    }
    // Forking is never automatic. Claude Code refuses to resume a conversation
    // that is already running as a background agent, but branching a copy
    // behind the user's back is not the answer: the background agent keeps
    // going, so they would end up with two divergent conversations when all
    // they wanted was theirs back. Restore skips such sessions entirely and
    // wake asks first — both pass this flag explicitly.
    const forkSession = providerId === 'claude' && !!resumeSessionId && args.forkSession === true;
    const cliArgs = adapter.buildArgs({
      sessionId: claudeSessionId,
      ateamSessionId: sessionId,
      resumeSessionId,
      forkSession,
      sessionName,
      cwd,
      appendSystemPrompt,
      settingsJson: sessionHookSettings(),
      mcpConfigPath,
      // the Human's model binding drives every session they run — chat mode
      // and the normal tree alike; absent = the runtime's own default
      ...(human.model ? { model: human.model } : {}),
      initialPrompt,
    });
    const spawnedAt = Date.now();
    const cols = args.cols ?? this.lastViewport?.cols ?? process.stdout.columns ?? 120;
    const rows = args.rows ?? this.lastViewport?.rows ?? process.stdout.rows ?? 32;
    const pty = ptySpawn(bin, cliArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      // stripClaudeProcessMarkers wraps the WHOLE merged object on purpose:
      // sanitising process.env alone did NOT work, because the login shell
      // below is a child of this process and prints the markers straight back
      // — and a key deleted from the second spread cannot remove one the first
      // spread already set. See claude-env.ts.
      env: stripClaudeProcessMarkers({
        // Login-shell env FIRST: a Launchpad-launched GUI app inherits
        // launchd's minimal env, so everything exported in ~/.zshrc —
        // third-party API endpoints (ANTHROPIC_BASE_URL/AUTH_TOKEN),
        // proxies, PATH additions — is missing and claude that works in
        // the user's terminal dies with exit 1 here. process.env still
        // wins on conflicts (ATEAM_HOME etc. are authoritative).
        ...loginShellEnv(),
        ...process.env,
        // PATH union (shell first) so claude + the npx it spawns for MCP
        // servers resolve user-installed tools.
        PATH: mergedPath(),
        // Ensure a UTF-8 locale for the claude PTY. A GUI app launched from
        // Launchpad/Finder inherits NO LANG, so the PTY comes up in the
        // C/POSIX locale and multi-byte UTF-8 (e.g. Chinese) gets corrupted
        // on copy/paste while ASCII survives. Only fill in when absent so a
        // terminal-launched session keeps the user's own locale.
        LANG: process.env.LANG ?? loginShellEnv().LANG ?? 'en_US.UTF-8',
        LC_CTYPE: process.env.LC_CTYPE ?? process.env.LANG ?? loginShellEnv().LANG ?? 'en_US.UTF-8',
        // Disable claude's "away summary" recaps by default for Ateam
        // sessions (the "disable recaps in /config" toggle). Scoped to the
        // spawned PTY only — the user's global claude config is untouched.
        // Respect an explicit pre-set value if the user wants recaps on.
        CLAUDE_CODE_ENABLE_AWAY_SUMMARY: process.env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY ?? '0',
        // Unique per-PTY tag so the SessionStart hook (session-hook.cjs) can
        // report THIS session's live claude id back to us on /clear rotation.
        ATEAM_SESSION: sessionId,
        // Lets the hook re-derive the exact same recall text (human-meta.ts
        // recallPrompt) on `/clear` — the CLI's --append-system-prompt only
        // applied to THIS process launch, and /clear wipes it with nothing
        // to replace it unless the hook re-injects it itself.
        ATEAM_HUMAN_ID: human.id,
        ATEAM_DIRECTORYLESS: directoryless ? '1' : '',
        // App-level proxy (Settings → General → Proxy). LAST so the
        // explicit in-app setting outranks whatever the login shell or
        // process env exported — flipping the toggle must actually
        // change where new sessions send traffic. Empty when disabled.
        ...proxyEnv(),
      }) as Record<string, string>,
    });

    const sess: Session = {
      node: {
        sessionId,
        projectId,
        agentId: randomUUID(),
        agentName: human.name,
        humanId: human.id,
        humanName: human.name,
        sessionName,
        role: human.role,
        workspaceId,
        cwd,
        claudeSessionId,
        providerId,
        ...(args.chat ? { chatId: args.chat.chatId } : {}),
      },
      pty,
      transcript: new Transcript(),
      state: 'starting',
      activeAt: Date.now(),
      cols,
      rows,
    };
    this.sessions.set(sessionId, sess);

    if (resumeHandoff) {
      const template = this.handoffTemplateFor(sess);
      const now = Date.now();
      if (isReusableDoc(resumeHandoff)) {
        // the doc survived the restart — spawn the successor from it once
        // the caller (restore) has registered this node, no prompt needed
        const path = resumeHandoff.handoffPath;
        this.lastHandoffAt.set(sessionId, now);
        this.handoffPendingSince.set(sessionId, now);
        setTimeout(() => void this.spawnSuccessor(sessionId, path, template), 1500);
      } else {
        this.armHandoff(sessionId, sess, template, now);
      }
    }

    pty.onData((d) => {
      sess.transcript.push(d);
      sess.screen ??= new ScreenMirror(sess.cols ?? 120, sess.rows ?? 32);
      sess.screen.write(d);
      const at = Date.now();
      sess.lastOutputAt = at;
      if (sess.typedAt !== undefined && sess.echoAt === undefined) sess.echoAt = at;
      this.emit('output', { sessionId, chunk: d });
      // if we've armed a handoff watcher on this session, accumulate a
      // rolling window of recent output (ANSI-stripped) and look for the
      // marker line claude writes after running Matt's handoff skill.
      const watch = this.handoffWatch.get(sessionId);
      if (watch) {
        // strip ANSI/CSI escapes so the regex doesn't have to deal with
        // claude's TUI color codes / cursor movements / repaints.
        // Standard ESC[…X CSI plus the OSC ESC]…BEL form. Line breaks are
        // KEPT in the window — the marker matcher below derives a joined
        // variant on demand (see there for the wrap story).
        const plain = (watch.window + d)
          .replace(/\x1b\][^\x07]*\x07/g, '')
          .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
        watch.window = plain.slice(-8192);

        // Auto-confirm claude's permission menus during the handoff flow.
        // Detection: the unmistakable claude menu signature — "1. Yes"
        // option AND a higher-numbered "3. No" within a few hundred chars.
        // (Detecting on the question text is brittle: TUI may render with
        // cursor positioning that produces no readable line in the byte
        // stream, AND the menu's "no input box · Esc to cancel · Tab to
        // amend" mode behaves differently from input mode.)
        //
        // Behavior: send `1\r` (number key + Enter is the most universal
        // selection chord). If the menu is still visible 1.5s later we
        // retry with `\r`, then `\n`, then `1\n`. After 4 attempts give up
        // — something is genuinely wrong and spamming keys risks corrupt-
        // ing claude's state.
        const fullWindow = watch.window;
        const menuVisible = /1\.\s*Yes[\s\S]{0,400}3\.\s*No/i.test(fullWindow.slice(-3072));
        const now = Date.now();
        if (!menuVisible) {
          // menu cleared (agent accepted / user accepted / scrolled out)
          // → reset attempt counter so the NEXT menu starts fresh.
          watch.menuAttempts = 0;
        } else {
          // The handoff watcher is armed → we're inside the unattended handoff
          // flow, so auto-confirm ANY permission menu. (The old code gated on
          // tmp/handoff path keywords, which missed codex's step-1 meta-index
          // write prompt and left the handoff hung — issue #1.)
          const since = now - (watch.lastMenuAttemptAt ?? 0);
          const attempt = watch.menuAttempts ?? 0;
          // first attempt fires immediately; subsequent ones throttled to
          // 1500ms so the agent has time to react before we re-key.
          if ((attempt === 0 || since > 1500) && attempt < 4) {
            // Provider-aware confirm key (#1): claude selects options by NUMBER
            // ("1"); codex/opencode use LETTER shortcuts ("1. Yes, proceed (y)"
            // → "y"). Sending the digit to codex did nothing → the hang.
            const letterMenu =
              sess.node.providerId === 'codex' || sess.node.providerId === 'opencode';
            const sequence = letterMenu ? ['y\r', '\r', 'y', 'y\n'] : ['1\r', '\r', '\n', '1\n'];
            const key = sequence[attempt] ?? '\r';
            sess.pty?.write(key);
            watch.lastMenuAttemptAt = now;
            watch.menuAttempts = attempt + 1;
          }
        }

        // Match the explicit ATEAM_HANDOFF_WRITTEN=<path> token the
        // prompt instructs claude to emit (see prompts/handoff.txt).
        // Stop at whitespace OR closing markup chars in case claude wraps.
        // We iterate ALL matches (not just the first) so an early echoed
        // placeholder doesn't disarm the watcher and hide the real one.
        //
        // WRAP TRAP (real production failure, 2026-08-14): claude's TUI
        // hard-wraps long lines to the pane width with a literal newline —
        // a narrow pane easily wraps the ~90-char marker line — and the
        // continuation line is usually indented to the block's text column.
        // The marker regex stops at whitespace, so it matched only up to
        // the wrap point (e.g. "/var/folders/rl"), which passed existsSync
        // (that prefix is itself a real dir on macOS) and got "confirmed"
        // as a directory — buildHandoffMessage then failed to read it and
        // spawnSuccessor silently no-oped: doc_ready forever, no successor,
        // no error surfaced anywhere. Fix: match against TWO views of the
        // window — as-is (unwrapped lines) and with every newline-plus-
        // indent run collapsed (rejoins wrapped lines, indented or not) —
        // and let the exists+isFile verification below discard whichever
        // variant produced a bogus join.
        const confirmed = findHandoffMarker(watch.window);
        if (confirmed) {
          // disarm BEFORE awaiting anything so a second match in the
          // same stream doesn't double-fire.
          this.handoffWatch.delete(sessionId);
          patchHandoffStatus(sess.node.claudeSessionId, {
            handoffPath: confirmed,
            status: 'doc_ready',
            docReadyAt: new Date().toISOString(),
          });
          void this.spawnSuccessor(sessionId, confirmed, watch.spawnTemplate);
        }
      }
    });
    pty.onExit(({ exitCode }) => {
      sess.screen?.dispose();
      sess.screen = undefined;
      // final drain so a message that landed right before exit still counts
      this.pollTurns(sessionId);
      this.stopTurnWatch(sessionId);
      // hibernate() kills the PTY on purpose and has already marked the node
      // 'hibernated' — this late SIGHUP exit (code 129) must NOT flip it to
      // 'exited', or the row turns into a dead tombstone that no longer wakes.
      if (sess.state === 'hibernated') return;
      sess.state = 'exited';
      this.emit('status', { sessionId, state: 'exited', exitCode });
    });

    this.startTurnWatch(sessionId, cwd, claudeSessionId);
    // codex assigns its own thread id — a FRESH codex session is keyed by
    // our placeholder UUID until we spot its rollout and re-key to the real
    // id (rename/resume/last-active all hang off it).
    if (providerId === 'codex' && !resumeSessionId) this.discoverCodexThread(sessionId, cwd);
    if (providerId === 'cursor' && !resumeSessionId)
      this.discoverCursorChat(sessionId, cwd, spawnedAt);
    sess.state = 'running';
    this.emit('status', { sessionId, state: 'running' });
    return this.toNode(sess);
  }

  /** Poll Cursor CLI's metadata after a fresh launch and re-key the Ateam row
   * once its native chat id is present. The stream reads `store.db` only after
   * that id exists; this scan itself stays on `meta.json`. */
  private discoverCursorChat(sessionId: string, cwd: string, spawnedAt: number): void {
    const isClaimed = (id: string): boolean =>
      [...this.sessions.values()].some(
        (x) => x.node.providerId === 'cursor' && x.node.claudeSessionId === id,
      );
    const timer = setInterval(() => {
      const s = this.sessions.get(sessionId);
      if (!s || !s.pty || s.state !== 'running') {
        clearInterval(timer);
        return;
      }
      // Cursor metadata contains cwd/time but no reliable PTY/process id. If
      // multiple fresh ATeam Cursor processes share this cwd, neither process
      // can safely claim a chat based on timing alone.
      const unresolvedInCwd = [...this.sessions.values()].filter(
        (x) =>
          x.node.providerId === 'cursor' &&
          x.node.cwd === cwd &&
          x.pty &&
          x.state !== 'exited' &&
          !cursorChatStorePath(x.node.cwd, x.node.claudeSessionId),
      );
      if (unresolvedInCwd.length !== 1) return;
      const id = discoverCursorChat(cwd, spawnedAt, isClaimed);
      if (!id) return;
      clearInterval(timer);
      this.linkClaudeSession(sessionId, id);
    }, 2000);
    timer.unref();
  }

  /** Poll ~/.codex/sessions until the rollout for a codex session we just
   *  spawned appears (codex writes it on the first turn), then re-key the
   *  session to codex's thread id via linkClaudeSession. Stops on its own
   *  when the session is gone / no longer live. */
  private discoverCodexThread(sessionId: string, cwd: string): void {
    const spawnedAt = Date.now();
    const isClaimed = (id: string): boolean =>
      [...this.sessions.values()].some((x) => x.node.claudeSessionId === id);
    const timer = setInterval(() => {
      const s = this.sessions.get(sessionId);
      if (!s || !s.pty || s.state !== 'running') {
        clearInterval(timer);
        return;
      }
      const id = discoverCodexThread(cwd, spawnedAt, isClaimed);
      if (!id) return;
      clearInterval(timer);
      this.linkClaudeSession(sessionId, id);
    }, 2000);
    timer.unref();
  }

  /** Start tailing the session's transcript jsonl. The offset starts at the
   *  CURRENT file size, so a resumed session's history is never replayed as
   *  fresh turns. */
  private startTurnWatch(sessionId: string, cwd: string, claudeSessionId: string): void {
    const providerId = this.sessions.get(sessionId)?.node.providerId ?? 'claude';
    const path =
      providerId === 'cursor'
        ? storeResumePath(providerId, cwd, claudeSessionId)
        : storeTranscriptPath(providerId, cwd, claudeSessionId);
    let offset = 0;
    try {
      offset = path && existsSync(path) ? statSync(path).size : 0;
    } catch {
      offset = 0;
    }
    // Path index: harvest what the agent has ALREADY touched (a resumed or
    // long-running session has a transcript full of absolute paths before we
    // ever attach) from a bounded tail read, then keep it current from the
    // same increments the turn watcher reads. One read, no traversal.
    // Cursor's store is SQLite, not newline JSONL, so it is not indexed here.
    const sess = this.sessions.get(sessionId);
    if (sess && providerId !== 'cursor') {
      sess.pathIndex ??= new SessionPathIndex();
      this.backfillPathIndex(sess.pathIndex, path, offset);
    }
    const timer = setInterval(() => this.pollTurns(sessionId), 1500);
    timer.unref();
    // Read on change, not only on the tick: the tick alone put 0–1.5s (0.75s
    // on average) between claude writing a record and the stream showing it,
    // on top of the CLI writing each block only once it is complete. The
    // interval stays — fs.watch can miss events or be unavailable.
    this.turnWatch.set(sessionId, {
      timer,
      watcher: this.watchTranscript(sessionId, path),
      path,
      offset,
      seq: 0,
      ...(providerId === 'cursor' ? { cursorSeen: cursorPromptCount(path), mark: '' } : {}),
      lastAppendAt: 0,
    });
  }

  /** undefined when the file does not exist yet — pollTurns tries again */
  private watchTranscript(sessionId: string, path: string): FSWatcher | undefined {
    if (!path) return undefined;
    try {
      const w = watch(path, () => this.pollTurns(sessionId));
      w.on('error', () => w.close());
      w.unref();
      return w;
    } catch {
      return undefined;
    }
  }

  private stopTurnWatch(sessionId: string): void {
    const w = this.turnWatch.get(sessionId);
    if (!w) return;
    clearInterval(w.timer);
    w.watcher?.close();
    this.turnWatch.delete(sessionId);
  }

  /** Read newly appended transcript bytes and emit a `turn` per complete
   *  record. Only whole lines are consumed — a partially written record
   *  stays buffered in the file until the next poll. */
  private pollTurns(sessionId: string): void {
    const w = this.turnWatch.get(sessionId);
    if (!w) return;
    const sess = this.sessions.get(sessionId);
    if (sess?.node.providerId === 'cursor' || w.cursorSeen !== undefined) {
      this.pollCursorTurns(sessionId);
      return;
    }
    let size: number;
    if (!w.path) return; // store location unknown yet (codex before first turn)
    try {
      size = statSync(w.path).size;
    } catch {
      return; // transcript not created yet
    }
    // the file exists now: start hearing about changes as they happen
    w.watcher ??= this.watchTranscript(sessionId, w.path);
    // shrink means the file was replaced (e.g. /clear); skip to the new end
    // rather than replaying content we can't attribute.
    if (size < w.offset) {
      w.offset = size;
      if (sess) sess.codexProjection = undefined;
      return;
    }
    if (size === w.offset) return;
    // growth = a real record is landing (or mid-write) → session is busy.
    // Feeds the handoff idle gate in handoffNow().
    w.lastAppendAt = Date.now();
    // cap a single drain so one giant paste can't stall the event loop
    const CHUNK = 1024 * 1024;
    const len = Math.min(size - w.offset, CHUNK);
    const buf = Buffer.alloc(len);
    let fd: number | undefined;
    try {
      fd = openSync(w.path, 'r');
      readSync(fd, buf, 0, len, w.offset);
    } catch {
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) {
      // No newline in the whole window. If the window is cap-sized, this is
      // a single record LARGER than the cap (giant base64 tool_result —
      // real transcripts have >1MB lines). Skip past it rather than
      // re-reading the same window every tick forever; the partial tail
      // that lands before the next newline fails JSON.parse and is
      // dropped harmlessly. If the window is smaller than the cap, the
      // record is still being written — wait for the next tick.
      if (len === CHUNK) w.offset += len;
      return;
    }
    w.offset += lastNl + 1;
    const turns: Turn[] = [];
    const lines = buf
      .subarray(0, lastNl + 1)
      .toString('utf8')
      .split('\n');
    const source =
      sess?.node.providerId === 'codex'
        ? this.codexSource(
            sess,
            w.path,
            sess.codexProjection
              ? lines
              : [...readChunk(w.path, SessionManager.TAIL_WINDOW, true), ...lines],
          )
        : undefined;
    const blocks = SessionManager.blocksFor(sess?.node.providerId, source);
    for (const line of lines) {
      sess?.pathIndex?.noteLine(line);
      const parsed = blocks(line, sessionId, w.seq);
      if (parsed.length === 0) continue;
      w.seq += parsed.length;
      turns.push(...parsed);
    }
    // Events are signals, not the archive: cap payload size AND count.
    // A huge backlog (compaction rewrite, mass append) must not turn into
    // thousands of websocket events — the tail carries the signal.
    for (const turn of turns.slice(-40)) {
      const textCap = turn.injected === 'handoff' ? HANDOFF_TURN_EVENT_CAP : 2000;
      this.emit('turn', {
        sessionId,
        turn: turn.text.length > textCap ? { ...turn, text: `${turn.text.slice(0, textCap)}…` } : turn,
      });
    }
  }

  /** Cursor writes a SQLite checkpoint, not a JSONL tail. Stat `store.db` and
   * its WAL, then emit only prompt messages newer than the count captured
   * when the watch started. */
  private pollCursorTurns(sessionId: string): void {
    const w = this.turnWatch.get(sessionId);
    if (!w?.path) return;
    let mark = '';
    try {
      const db = statSync(w.path);
      let wal = '';
      try {
        const side = statSync(`${w.path}-wal`);
        wal = `:${side.size}:${side.mtimeMs}`;
      } catch {
        // no WAL yet, or the CLI is in rollback-journal mode
      }
      mark = `${db.size}:${db.mtimeMs}${wal}`;
    } catch {
      return;
    }
    if (mark === w.mark) return;
    w.mark = mark;
    const page = readCursorStreamPage(w.path, sessionId);
    const seen = w.cursorSeen ?? 0;
    if (page.total < seen) {
      w.cursorSeen = page.total;
      return;
    }
    const fresh = page.turns.filter((turn) => Math.floor(turn.seq / 100) >= seen);
    w.cursorSeen = page.total;
    if (fresh.length === 0) return;
    w.lastAppendAt = Date.now();
    for (const turn of fresh.slice(-40)) {
      const textCap = turn.injected === 'handoff' ? HANDOFF_TURN_EVENT_CAP : 2000;
      this.emit('turn', {
        sessionId,
        turn: turn.text.length > textCap ? { ...turn, text: `${turn.text.slice(0, textCap)}…` } : turn,
      });
    }
  }

  /** Build the first-user-message that carries the handoff doc into a
   *  successor session. Returns undefined if the doc is unreadable. The doc
   *  is capped to ~40KB (fits comfortably under ARG_MAX as a positional CLI
   *  prompt); the full file always remains at `handoffPath`. */
  private buildHandoffMessage(handoffPath: string): string | undefined {
    let handoffContent = '';
    try {
      handoffContent = readFileSync(handoffPath, 'utf8');
    } catch {
      return undefined;
    }
    const capped =
      handoffContent.length > 40_000
        ? `${handoffContent.slice(0, 40_000)}\n\n[…handoff truncated — full doc at ${handoffPath}]`
        : handoffContent;
    return [
      'I am taking over from a previous session that hit the context limit.',
      `Below is the handoff document from that session (full file: ${handoffPath}).`,
      'Pick up the work from where it left off. Do not re-introduce yourself.',
      '',
      '--- HANDOFF ---',
      capped,
      '--- END HANDOFF ---',
    ].join('\n');
  }

  private readonly heldInput = new Map<string, HeldInput>();
  private readonly holdDeps: HoldDeps = {
    write: (sid, data) => this.writeInput(sid, data),
    onFirstTurn: (sid, cb) => {
      const listener = (d: { sessionId: string }): void => {
        if (d.sessionId === sid) cb();
      };
      this.on('turn', listener);
      return () => this.off('turn', listener);
    },
    setTimer: (cb, ms) => {
      setTimeout(cb, ms);
    },
  };

  /** Both RPC input and peer messages must survive a handoff to the successor. */
  input(sessionId: string, data: string): { held?: boolean } {
    // Chinese punctuation never reaches the CLI. Control sequences have none
    // of these marks, so Esc / arrows / bracketed-paste markers pass through.
    const text = asciiPunctuation(data);
    if (this.isHandingOff(sessionId)) {
      const held = this.heldInput.get(sessionId) ?? new HeldInput();
      this.heldInput.set(sessionId, held);
      const pass = held.feed(text);
      if (pass) this.writeInput(sessionId, pass);
      return { held: true };
    }
    const stale = this.heldInput.get(sessionId);
    if (stale) {
      // A failed handoff returns the queued words to the original session.
      this.heldInput.delete(sessionId);
      typeIn(stale, sessionId, this.holdDeps);
      setTimeout(() => this.writeInput(sessionId, text), (stale.messages.length * 2 + 1) * 200);
      return {};
    }
    this.writeInput(sessionId, text);
    return {};
  }

  private writeInput(sessionId: string, data: string): void {
    const s = this.require(sessionId);
    s.activeAt = Date.now(); // typing counts as use, long before a record lands
    this.lastInputAt.set(sessionId, s.activeAt);
    if (!s.pty) return; // hibernated: dropped — the UI wakes on focus first
    const dialogEnter = data === '\r' && !s.afterSubmit && s.screen?.dialogVisible() === true;
    if (data === '\r' && !dialogEnter) s.submittedAt = s.activeAt;
    if (s.afterSubmit) s.afterSubmit.push(data);
    else if (dialogEnter) s.pty.write('\r');
    else if (data === '\r') this.submitWhenRead(s);
    else this.typeInto(s, data);
  }

  /** Write text the TUI is expected to echo, and start the clock that
   *  submitWhenRead waits on. Every path into the PTY goes through here
   *  (including handoff/checkpoint pastes that skip `input`), so punctuation
   *  is rewritten even when the caller did not go through `input`. */
  private typeInto(s: Session, data: string): void {
    s.typedAt = Date.now();
    s.echoAt = undefined;
    s.pty?.write(asciiPunctuation(data));
  }

  /**
   * Press Enter only once the TUI has read what was typed before it.
   *
   * The text and the Enter are two writes, and they must reach claude as two
   * reads: arriving together, the Enter is taken as part of the paste (or the
   * keystroke burst) and the message sits in the input box unsent. A fixed
   * gap after OUR write was the old guard, and it fails exactly when the
   * machine is busy — claude's loop does not read stdin for longer than the
   * gap, both land in the buffer, one read takes them. So wait for evidence
   * that the text was read: output after it (the TUI redrawing its box), then
   * a short quiet spell, or a bounded extra beat if something (a spinner)
   * keeps printing. If the TUI stays silent the Enter goes anyway, late —
   * never later than SUBMIT_MAX_WAIT_MS.
   */
  private submitWhenRead(s: Session): void {
    this.writeWhenRead(s, '\r');
  }

  /**
   * Pull the CLI's queued messages back out, the way its own Up key does, and
   * leave its input box empty — the stream's composer holds them instead.
   * Up moves every queued message into the TUI's box (one `popAll` record
   * each); `clearChars` Backspaces then empty it. Measured on 2.1.281: extra
   * Backspaces on an empty box do nothing, while Ctrl+C mid-turn with text in
   * the box INTERRUPTS the turn instead of clearing — so never that. The
   * Backspaces wait, like the Enter, until the TUI has drawn what Up brought
   * back (docs/stream/queue-edit-cli-probe.md).
   */
  pullQueue(sessionId: string, clearChars: number): void {
    const s = this.require(sessionId);
    if (!s.pty || s.afterSubmit) return;
    s.activeAt = Date.now();
    this.lastInputAt.set(sessionId, s.activeAt);
    this.typeInto(s, '\x1b[A');
    this.writeWhenRead(s, '\x7f'.repeat(Math.max(0, Math.min(clearChars, 20_000))));
  }

  private writeWhenRead(s: Session, key: string): void {
    const start = Date.now();
    const typedAt = s.typedAt;
    s.afterSubmit ??= [];
    const tick = (): void => {
      const pty = s.pty;
      if (!pty) {
        s.afterSubmit = undefined;
        return;
      }
      const now = Date.now();
      const echo = typedAt !== undefined && s.typedAt === typedAt ? s.echoAt : now;
      const read =
        echo !== undefined &&
        (now - (s.lastOutputAt ?? echo) >= SUBMIT_QUIET_MS || now - echo >= SUBMIT_BUSY_MS);
      if (read || typedAt === undefined || now - start >= SUBMIT_MAX_WAIT_MS) {
        if (s.typedAt === typedAt) s.typedAt = undefined;
        pty.write(key);
        const later = s.afterSubmit ?? [];
        s.afterSubmit = undefined;
        if (this.sessions.get(s.node.sessionId) === s)
          for (const d of later) this.input(s.node.sessionId, d);
        return;
      }
      setTimeout(tick, SUBMIT_POLL_MS);
    };
    tick();
  }

  kill(sessionId: string): void {
    this.sessions.get(sessionId)?.pty?.kill();
  }

  /** Permanently remove a session: kill the PTY and drop it from the map
   *  so list() no longer returns it (kill alone leaves an 'exited'
   *  tombstone). Also clears any pending handoff watcher / token caches
   *  keyed on it. */
  delete(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      s.pty?.kill();
    } catch {
      /* already dead */
    }
    this.sessions.delete(sessionId);
    this.handoffWatch.delete(sessionId);
    this.stopTurnWatch(sessionId);
    this.lastHandoffAt.delete(sessionId);
    this.handoffPendingSince.delete(sessionId);
  }

  /** Seed a fresh index from the tail of an existing transcript. Bounded to
   *  the last 512KB and to whole lines — this runs on the sidecar's only
   *  thread, so it must stay a single cheap read no matter how long the
   *  conversation is. */
  private backfillPathIndex(ix: SessionPathIndex, path: string, size: number): void {
    const WINDOW = 512 * 1024;
    if (!path || size <= 0) return;
    const len = Math.min(size, WINDOW);
    const buf = Buffer.alloc(len);
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      readSync(fd, buf, 0, len, size - len);
    } catch {
      return; // transcript unreadable — the live tail will fill the index
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const text = buf.toString('utf8');
    // when the window starts mid-record, drop that first partial line
    const lines = text.split('\n');
    if (len < size) lines.shift();
    for (const line of lines) ix.noteLine(line);
  }

  /**
   * Resolve a reference clicked in the terminal to a file on disk, in order:
   * an absolute path as given, then the reference joined to each root we know
   * (the cwd the AGENT last reported, the session cwd, then the caller's
   * attached locations), then the session's path index — the files this agent
   * actually opened. Every step is a map lookup or a single existsSync; there
   * is deliberately no filesystem search here (see path-index.ts).
   *
   * `tried` comes back so the UI can say WHERE it looked instead of just "not
   * found", and `candidates` carries the ambiguous case (same filename in
   * several directories) for the caller to disambiguate.
   */
  resolvePath(
    sessionId: string,
    ref: string,
    roots: readonly string[] = [],
  ): { path?: string; candidates: string[]; tried: string[] } {
    const tried: string[] = [];
    const s = this.sessions.get(sessionId);
    const home = process.env.HOME ?? '';
    const expanded = ref.startsWith('~/') && home ? join(home, ref.slice(2)) : ref;
    if (expanded.startsWith('/')) {
      tried.push(expanded);
      return existsSync(expanded)
        ? { path: expanded, candidates: [expanded], tried }
        : { candidates: [], tried };
    }
    const rel = expanded.replace(/^\.\//, '');
    if (!rel) return { candidates: [], tried };
    // The directories the agent has actually stood in come BEFORE the caller's
    // extra roots: a path printed by `cd <dir> && cat > docs/x.md` belongs to
    // <dir>, and the session cwd is simply the wrong answer for it.
    const roots2 = [
      s?.pathIndex?.cwd(),
      s?.node.cwd,
      ...(s?.pathIndex?.dirs() ?? []),
      ...roots,
    ].filter((r): r is string => Boolean(r));
    for (const root of [...new Set(roots2)]) {
      const cand = `${root.replace(/\/+$/, '')}/${rel}`;
      if (tried.includes(cand)) continue;
      tried.push(cand);
      if (existsSync(cand)) return { path: cand, candidates: [cand], tried };
    }
    // the agent's own history: bounded list, so these stats are bounded too
    const hits = (s?.pathIndex?.resolve(rel) ?? []).filter((p) => existsSync(p));
    if (hits.length === 1 && hits[0]) return { path: hits[0], candidates: hits, tried };
    return { candidates: hits, tried };
  }

  /** Prime the house default pane size before the first spawn (see
   *  lastViewport) — the client measures its stage right after connecting. */
  setViewport(cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return;
    this.lastViewport = { cols, rows };
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return; // hidden pane measuring 0×0
    // Remember the size, both for this session (wake() resumes at it) and as
    // the house default for the NEXT spawn — every pane in a client shares one
    // stage box, so the last reported size is what a new session will land in.
    this.lastViewport = { cols, rows };
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.cols === cols && s.rows === rows) return;
    s.activeAt = Date.now();
    s.cols = cols;
    s.rows = rows;
    s.pty?.resize(cols, rows);
    s.screen?.resize(cols, rows);
    // Tell every attached client the new winsize. One of them may be showing
    // this session in the stream view, where its xterm is display:none and so
    // can never measure itself — it has to be told, or it keeps parsing a
    // frame laid out for a size it isn't.
    this.emit('resize', { sessionId, cols, rows });
  }

  /** The PTY's current size — what a client that cannot measure itself needs
   *  in order to lay its emulator out the same way. */
  sizeOf(sessionId: string): { cols: number; rows: number } | undefined {
    const s = this.sessions.get(sessionId);
    return s?.cols && s.rows ? { cols: s.cols, rows: s.rows } : undefined;
  }

  /** Kill a session's PTY but keep its node in the tree as 'hibernated'.
   *  The conversation is safe on disk; wake() resumes it. */
  hibernate(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || !s.pty || s.state === 'exited') return;
    if (this.handoffWatch.has(sessionId)) return; // mid-handoff — never
    try {
      s.pty.kill();
    } catch {
      /* already dead */
    }
    s.pty = undefined;
    s.state = 'hibernated';
    this.stopTurnWatch(sessionId);
    this.emit('status', { sessionId, state: 'hibernated' });
  }

  /** Wake a hibernated session: respawn claude with --resume on the same
   *  conversation. The node is REPLACED (fresh sessionId) — callers get the
   *  successor back and should refocus it. */
  wake(sessionId: string, opts?: { fork?: boolean }): SessionNode {
    const s = this.require(sessionId);
    if (s.state !== 'hibernated') return this.toNode(s);
    const n = s.node;
    // Already running as one of Claude Code's background agents? Then there is
    // nothing to wake — it never stopped. `--resume` refuses it, and forking
    // behind the user's back would leave them with two live conversations, so
    // say so and let them ask for the copy.
    if (!opts?.fork && (n.providerId ?? 'claude') === 'claude') {
      if (isRunningAsBackgroundAgent(n.claudeSessionId)) {
        const err = new Error(
          'this conversation is running as a Claude Code background agent — attach to it with `claude agents`, or open a forked copy here',
        ) as Error & { code?: string };
        err.code = 'bg_agent_running';
        throw err;
      }
    }
    // Boot the resumed claude at the size this pane was last drawn at, so it
    // paints its restored conversation ONCE at the right width instead of
    // painting narrow and repainting after the pane's first fit.
    const { cols, rows } = s;
    this.sessions.delete(sessionId); // no tombstone — the successor replaces it
    return this.spawn({
      cols,
      rows,
      projectId: n.projectId,
      projectName: this.projectNames.get(n.projectId),
      agentName: n.agentName,
      role: n.role,
      human: { id: n.humanId, name: n.humanName, role: n.role },
      workspace:
        n.workspaceId === 'direct'
          ? undefined
          : { id: n.workspaceId, name: n.sessionName, root: n.cwd },
      directoryless: n.workspaceId === 'direct',
      resumeSessionId: n.claudeSessionId,
      sessionName: storeTitle(n.providerId ?? 'claude', n.cwd, n.claudeSessionId) || n.sessionName,
      providerId: n.providerId,
      ...(opts?.fork ? { forkSession: true } : {}),
    });
  }

  /** Register a session directly in the hibernated state (no claude boot).
   *  Restore uses this for sessions that have been quiet past the
   *  hibernate window — the tree shows them, clicking wakes them. */
  addHibernated(args: {
    projectName: string;
    agentName: string;
    role: string;
    dir: string;
    claudeSessionId: string;
    directoryless?: boolean;
    providerId?: ProviderId;
  }): SessionNode {
    const human = ensureHuman({ name: args.agentName, role: args.role });
    const providerId: ProviderId = args.providerId ?? 'claude';
    const cwd = args.directoryless ? humanDeskDir(human.id) : args.dir;
    let projectId: string | undefined;
    for (const [id, name] of this.projectNames) {
      if (name === args.projectName) {
        projectId = id;
        break;
      }
    }
    projectId ??= randomUUID();
    this.projectNames.set(
      projectId,
      args.projectName || (args.directoryless ? human.name : basename(cwd)),
    );
    const sessionId = randomUUID();
    const sess: Session = {
      node: {
        sessionId,
        projectId,
        agentId: randomUUID(),
        agentName: human.name,
        humanId: human.id,
        humanName: human.name,
        sessionName: (
          storeTitle(providerId, cwd, args.claudeSessionId) ||
          args.projectName ||
          basename(cwd)
        ).slice(0, 40),
        role: human.role,
        workspaceId: args.directoryless ? 'direct' : `ws-${args.dir}`,
        cwd,
        claudeSessionId: args.claudeSessionId,
        providerId,
      },
      transcript: new Transcript(),
      state: 'hibernated',
      activeAt: 0,
    };
    this.sessions.set(sessionId, sess);
    this.emit('status', { sessionId, state: 'hibernated' });
    return this.toNode(sess);
  }

  private hibernateSweep(): void {
    const { hibernate } = loadConfig();
    if (!hibernate.enabled) return;
    const cutoff = Date.now() - hibernate.idleHours * 3600_000;
    for (const [id, s] of this.sessions) {
      if (s.state !== 'running' || !s.pty) continue;
      const recorded = storeLastActiveAt(
        s.node.providerId ?? 'claude',
        s.node.cwd,
        s.node.claudeSessionId,
      );
      if (isIdleForHibernation(recorded, s.activeAt, cutoff)) this.hibernate(id);
    }
  }

  /** How much of a transcript the first stream-view load parses. Older
   *  history is fetched a window at a time (transcriptBefore) when the user
   *  scrolls to the top — a 50MB file must never be parsed up front on the
   *  sidecar's only thread. */
  private static readonly TAIL_WINDOW = 768 * 1024;

  /** Where the tail window served by transcript() starts, and whether
   *  anything precedes it (drives the "load older" affordance). */
  transcriptWindow(sessionId: string): { fromByte: number; hasMore: boolean } {
    const s = this.require(sessionId);
    if ((s.node.providerId ?? 'claude') === 'cursor') {
      const store = storeResumePath('cursor', s.node.cwd, s.node.claudeSessionId);
      if (!store) return { fromByte: 0, hasMore: false };
      const page = readCursorStreamPage(store, sessionId);
      return { fromByte: page.fromIndex, hasMore: page.hasMore };
    }
    const path = storeTranscriptPath(
      s.node.providerId ?? 'claude',
      s.node.cwd,
      s.node.claudeSessionId,
    );
    try {
      const size = statSync(path).size;
      const fromByte = Math.max(0, size - SessionManager.TAIL_WINDOW);
      return { fromByte, hasMore: fromByte > 0 };
    } catch {
      return { fromByte: 0, hasMore: false };
    }
  }

  /** One window of older history, ending just before `beforeByte`. The
   *  stream view calls this when the user scrolls to the top, walking the
   *  file backwards a window at a time instead of parsing 50MB up front. */
  transcriptBefore(
    sessionId: string,
    beforeByte: number,
    bytes = 512 * 1024,
  ): { turns: Turn[]; fromByte: number; hasMore: boolean } {
    const s = this.require(sessionId);
    if ((s.node.providerId ?? 'claude') === 'cursor') {
      const store = storeResumePath('cursor', s.node.cwd, s.node.claudeSessionId);
      if (!store || beforeByte <= 0) return { turns: [], fromByte: 0, hasMore: false };
      const page = readCursorStreamPage(store, sessionId, beforeByte);
      return { turns: page.turns, fromByte: page.fromIndex, hasMore: page.hasMore };
    }
    const path = storeTranscriptPath(
      s.node.providerId ?? 'claude',
      s.node.cwd,
      s.node.claudeSessionId,
    );
    if (!existsSync(path) || beforeByte <= 0) return { turns: [], fromByte: 0, hasMore: false };
    const { lines, fromByte } = readWindowBefore(path, beforeByte, bytes);
    const blocks = SessionManager.blocksFor(
      s.node.providerId,
      s.node.providerId === 'codex'
        ? this.codexSource(s, path, [...lines, ...readChunk(path, SessionManager.TAIL_WINDOW, true)])
        : undefined,
    );
    const turns: Turn[] = [];
    for (const line of lines) turns.push(...blocks(line, sessionId, turns.length));
    return { turns, fromByte, hasMore: fromByte > 0 };
  }

  /** Which block parser a session's store needs. Claude and codex share no
   *  record shape at all, and running the wrong one over a file yields not an
   *  error but SILENCE — zero turns, an empty stream, and a terminal that
   *  still looks fine because it shows raw PTY output. That is exactly how
   *  codex sessions read as blank on a phone. */
  private static blocksFor(
    providerId: ProviderId | undefined,
    options?: CodexProjectionOptions,
  ) {
    return providerId === 'codex'
      ? (line: string, sessionId: string, nextSeq: number) =>
          parseCodexBlocks(line, sessionId, nextSeq, options)
      : parseTranscriptBlocks;
  }

  private codexSource(
    s: Session,
    path: string,
    lines: readonly string[],
  ): CodexProjectionOptions {
    if (s.codexProjection?.path !== path)
      s.codexProjection = {
        path,
        toolSource: 'event_msg',
        responseCallIds: new Set(),
        responseOutputIds: new Set(),
      };
    if (codexToolSource(lines) === 'response_item') s.codexProjection.toolSource = 'response_item';
    const { responseCallIds } = s.codexProjection;
    for (const id of codexResponseCallIds(lines)) {
      responseCallIds.delete(id);
      responseCallIds.add(id);
      if (responseCallIds.size > 20000)
        responseCallIds.delete(responseCallIds.values().next().value as string);
    }
    const { responseOutputIds } = s.codexProjection;
    for (const id of codexResponseOutputIds(lines)) {
      responseOutputIds.delete(id);
      responseOutputIds.add(id);
      if (responseOutputIds.size > 20000)
        responseOutputIds.delete(responseOutputIds.values().next().value as string);
    }
    return { toolSource: s.codexProjection.toolSource, responseCallIds, responseOutputIds };
  }

  /** Commands this session left running in the background. */
  bgShells(
    sessionId: string,
  ): (BgShellInfo & {
    progress?: BgProgress;
    lastLine?: string;
    label?: string;
    monitor?: boolean;
    sources?: { name: string; progress: BgProgress }[];
    agentId?: string;
    statusUnknown?: boolean;
  })[] {
    const s = this.require(sessionId);
    const { cwd, claudeSessionId } = s.node;
    if (s.node.providerId === 'codex') return listCodexBackground(claudeSessionId);
    const isClaude = (s.node.providerId ?? 'claude') === 'claude';
    if (!isClaude) return [];
    const transcript = transcriptPath(cwd, claudeSessionId);
    const list = listBackgroundShells(cwd, claudeSessionId).flatMap((sh) => {
      // A Monitor is a watcher, not work of its own, and it used to be left
      // out: its task file holds the lines it matched in ANOTHER command's
      // output, so read for a progress figure it doubled that command in the
      // bar, and it never gets an exit marker, so it stayed "running" after
      // its source ended. But a Monitor polling a remote machine every 15
      // minutes is the only live thing some sessions have, and the panel
      // showed nothing at all (09-22). So it is listed on its own terms: by
      // its own `description`, with its latest event and no figure, and over
      // once the harness says so — the end notice is the one that carries a
      // <status>.
      const origin = isClaude ? sessionTask(transcript, sh.id) : undefined;
      if (origin?.monitor) {
        const label = origin.description || commandLabel(origin.command);
        if (sh.done || taskEnded(transcript, sh.id))
          return [{ ...sh, done: true, monitor: true, ...(label ? { label } : {}) }];
        const out = this.bgShellOutput(sessionId, sh.id, 16 * 1024);
        const lastLine = progressOf(out.text).lastLine;
        // a watcher's figures, one per log it reads (it has no figure of its
        // own — see progressBySource for why they are kept apart)
        const sources = this.timedSources(`${sessionId}:${sh.id}`, out, sh.startedAtMs);
        return [
          {
            ...sh,
            monitor: true,
            ...(label ? { label } : {}),
            ...(lastLine ? { lastLine } : {}),
            ...(sources.length ? { sources } : {}),
          },
        ];
      }
      if (sh.done) return [sh];
      // what claude itself calls the task (Bash `description`)
      const task = isClaude
        ? (origin ?? unannouncedTask(transcript, sh.startedAtMs))
        : undefined;
      // Over without an exit marker: the harness reported it over (a notice
      // with a <status>, or TaskStop) — once read for Monitors only — or the
      // sub-agent that started it has finished and it has been silent since.
      // A wait loop left by an agent that ended the evening before sat in the
      // panel as running, its process long gone (09-30).
      if (isClaude && (taskEnded(transcript, sh.id) || ownerFinished(task?.agentLog, sh.lastAt)))
        return [{ ...sh, done: true }];
      // a sub-agent's foreground call: its own row already shows this command
      if (task?.bySubagent && !origin) return [];
      // claude's name for it; a sub-agent often gives none — then the command's own
      const label = task?.description || (task?.command ? commandLabel(task.command) : undefined);
      // a running command's progress rides along, so the view needs no extra poll
      const out = this.bgShellOutput(sessionId, sh.id, 16 * 1024);
      // several logs interleaved: a bar each, never one figure jumping between them
      const sources = this.timedSources(`${sessionId}:${sh.id}`, out, sh.startedAtMs);
      if (sources.length >= 2) {
        const lastLine = progressOf(out.text).lastLine;
        return [
          {
            ...sh,
            ...(label ? { label } : {}),
            ...(lastLine ? { lastLine } : {}),
            sources,
          },
        ];
      }
      const parsed = progressOf(out.text);
      // tqdm's own clock when it prints one, else a rate from watching the figure move
      const progress = parsed.progress && {
        ...parsed.progress,
        ...(parsed.tqdm ??
          observeProgress(`${sessionId}:${sh.id}`, parsed.progress, Date.now(), {
            startedAtMs: sh.startedAtMs,
            changedAtMs: out.mtimeMs,
            history:
              parsed.progress.total !== undefined
                ? stampedHistory(out.text, parsed.progress.total)
                : undefined,
          })),
      };
      // a silent download: the growing file is the only sign of life
      const lastLine = parsed.lastLine || writingLine(out.files);
      return {
        ...sh,
        ...(label ? { label } : {}),
        ...(progress ? { progress } : {}),
        ...(lastLine ? { lastLine } : {}),
      };
    });
    // which sub-agent started it: the panel draws it inside that agent's row
    return list.map((sh) => {
      const agentId = isClaude ? agentIdOfLog(sessionTask(transcript, sh.id)?.agentLog) : undefined;
      return agentId ? { ...sh, agentId } : sh;
    });
  }

  /** Copy the agents' logs to the successor once the old claude has exited —
   *  dying, it still writes the interrupted tool's result into them. Capped:
   *  a process that will not report its exit gets the copy after 5s anyway. */
  private moveSubagentsWhenGone(
    pty: IPty | undefined,
    from: { cwd: string; claudeSessionId: string },
    to: { cwd: string; claudeSessionId: string },
    agentIds: string[],
  ): void {
    let done = false;
    const move = (): void => {
      if (done) return;
      done = true;
      // one that could not be copied shows up as the successor's SendMessage
      // failing with "no transcript found" — visible where it matters
      copySubagents(from, to, agentIds);
    };
    if (!pty) return move();
    pty.onExit(() => setTimeout(move, 200));
    setTimeout(move, 5000).unref();
  }

  /** progressBySource, each figure timed on its own track */
  private timedSources(
    key: string,
    out: { text: string; mtimeMs?: number },
    startedAtMs: number | undefined,
  ): { name: string; progress: BgProgress }[] {
    return progressBySource(out.text).map((src) => ({
      name: src.source,
      progress: {
        ...src.progress,
        ...(src.tqdm ??
          observeProgress(`${key}:${src.source}`, src.progress, Date.now(), {
            startedAtMs,
            changedAtMs: out.mtimeMs,
            history:
              src.progress.total !== undefined
                ? stampedHistory(src.text, src.progress.total)
                : undefined,
          })),
      },
    }));
  }

  /** The command (and its name) behind a task id: an announced background
   *  task by its id, else — a long foreground Bash is a task too but never
   *  announced — the Bash call still waiting for its result. */
  private bgTask(
    cwd: string,
    claudeSessionId: string,
    id: string,
  ): { command: string; description: string } | undefined {
    const transcript = transcriptPath(cwd, claudeSessionId);
    // a sub-agent's tasks share this directory: an unannounced one is matched
    // to a pending call by when its file was born, never simply handed the
    // parent's pending Bash
    return sessionTask(transcript, id) ?? unannouncedTask(transcript, taskBornAt(cwd, claudeSessionId, id));
  }

  bgShellOutput(sessionId: string, id: string, tailBytes?: number) {
    const s = this.require(sessionId);
    if (s.node.providerId === 'codex') return readCodexBackground(s.node.claudeSessionId, id, tailBytes);
    if ((s.node.providerId ?? 'claude') !== 'claude')
      return { text: '', bytes: 0, truncated: false, done: true };
    const { cwd, claudeSessionId } = s.node;
    const task =
      (s.node.providerId ?? 'claude') === 'claude' ? this.bgTask(cwd, claudeSessionId, id) : undefined;
    const command = task?.command;
    const logPath = command ? liveTarget(redirectTargets(command, cwd)) : undefined;
    const out = readBackgroundShell(cwd, claudeSessionId, id, tailBytes, logPath);
    const files = command ? fileSizes(outputFiles(command, cwd)) : [];
    return {
      ...out,
      ...(command ? { command } : {}),
      ...(task?.description ? { label: task.description } : {}),
      ...(files.length ? { files } : {}),
    };
  }

  /** Sub-agents this session has launched. Their conversations never reach
   *  the session's own transcript — see subagents.ts — so they are read from
   *  the harness's task files instead. */
  subagents(sessionId: string): SubagentInfo[] {
    const s = this.require(sessionId);
    if (s.node.providerId === 'codex') return listCodexSubagents(s.node.claudeSessionId);
    if ((s.node.providerId ?? 'claude') !== 'claude') return [];
    return listSubagents(s.node.cwd, s.node.claudeSessionId);
  }

  /** One sub-agent's conversation, in the same Turn blocks a session's own
   *  transcript produces — the stream renders both with one code path. */
  subagentTranscript(sessionId: string, agentId: string): Turn[] {
    const s = this.require(sessionId);
    if (s.node.providerId === 'codex')
      return readCodexSubagentTranscript(s.node.claudeSessionId, agentId);
    if ((s.node.providerId ?? 'claude') !== 'claude') return [];
    return readSubagentTranscript(s.node.cwd, s.node.claudeSessionId, agentId);
  }

  transcript(sessionId: string, since = 0): Turn[] {
    const s = this.require(sessionId);
    if ((s.node.providerId ?? 'claude') === 'cursor') {
      const store = storeResumePath('cursor', s.node.cwd, s.node.claudeSessionId);
      if (store) {
        const page = readCursorStreamPage(store, sessionId);
        return since > 0 ? page.turns.filter((turn) => turn.seq >= since) : page.turns;
      }
    }
    // Real source: the provider's on-disk JSONL — structured, lossless,
    // width-independent (this is what the stream view renders). Tail-capped
    // so a 50MB transcript doesn't stall the sidecar's only thread; the cap
    // is whole-line aligned by readChunk.
    const path = storeTranscriptPath(
      s.node.providerId ?? 'claude',
      s.node.cwd,
      s.node.claudeSessionId,
    );
    if (existsSync(path)) {
      const lines = readChunk(path, SessionManager.TAIL_WINDOW, true);
      const blocks = SessionManager.blocksFor(
        s.node.providerId,
        s.node.providerId === 'codex' ? this.codexSource(s, path, lines) : undefined,
      );
      const turns: Turn[] = [];
      for (const line of lines) {
        turns.push(...blocks(line, sessionId, turns.length));
      }
      return since > 0 ? turns.filter((t) => t.seq >= since) : turns;
    }
    // no store file (fresh session pre-first-turn, foreign provider format)
    // → the old ANSI-stripped PTY snapshot placeholder
    return s.transcript.toTurns(sessionId, since);
  }

  /** the real working directory of a session (for per-project command scans) */
  cwdOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.node.cwd;
  }

  /** raw PTY tail for terminal attach/replay (see Transcript.rawTail) */
  rawTail(sessionId: string): string {
    return this.require(sessionId).transcript.rawTail();
  }

  /** Rebind a live session to a different Human. The PTY keeps running (the
   *  Claude CLI's --name was baked in at spawn time), but every UI list +
   *  every drops/recall attribution from this point forward keys on the new
   *  Human. recordHumanProject ensures the new Human "owns" this dir going
   *  forward (and shows up correctly in their growth/expertise reports). */
  /** Trigger auto-handoff on a session. Steps:
   *    1. Idle gate — refuse if the session's transcript grew in the
   *       last 3 seconds (we don't want to inject mid-turn while claude
   *       is still working).
   *    2. Same-session dedupe — refuse if we already fired in the last 60s.
   *    3. Inject Matt Pocock's handoff skill body via bracketed-paste
   *       escape sequence (\e[200~…\e[201~) — claude's TUI handles this
   *       as a single "pasted N lines" event instead of streaming the
   *       characters one-by-one.
   *    4. Arm the handoff watcher: every subsequent output chunk is
   *       scanned for "handoff written: <path>". On match, spawn the
   *       successor session with --append-system-prompt = handoff doc
   *       content, then emit session.replaced so the UI can swap to
   *       the dual-pane stack. */
  /** Whether an auto-handoff is in flight for this session (prompt injected,
   *  successor not yet up). Chat mode uses it to hold a user's message until
   *  the successor exists instead of injecting into a session mid-handoff. */
  isHandingOff(sessionId: string): boolean {
    const at = this.handoffPendingSince.get(sessionId);
    return at !== undefined && Date.now() - at < 10 * 60_000;
  }

  /** Whether the session is mid-turn right now: its transcript grew within
   *  the last few seconds. Same signal as the handoff idle gate. Chat mode
   *  tells a teammate's chat-side self whether its work side is busy. */
  isBusy(sessionId: string): boolean {
    const w = this.turnWatch.get(sessionId);
    return !!w && w.lastAppendAt > 0 && Date.now() - w.lastAppendAt < 5000;
  }

  handoffNow(
    sessionId: string,
    focusHint?: string,
    successorProviderId?: ProviderId,
  ): { triggered: boolean; reason?: string } {
    const s = this.sessions.get(sessionId);
    if (!s) return { triggered: false, reason: 'no such session' };
    if (s.state === 'exited') return { triggered: false, reason: 'session exited' };
    if (!s.pty) return { triggered: false, reason: 'session hibernated' };
    const now = Date.now();
    const last = this.lastHandoffAt.get(sessionId) ?? 0;
    if (now - last < 60_000) {
      return { triggered: false, reason: 'already triggered within last 60s' };
    }
    // idle gate: 3s with no transcript growth ≈ claude is between turns /
    // waiting on user input. Keyed on the transcript jsonl (not PTY bytes —
    // the TUI repaints even at rest, a PTY gate rejects forever). Worst
    // case a long text-only generation looks quiet mid-turn; the injected
    // prompt is then queued by claude's TUI and runs after the turn ends.
    const w = this.turnWatch.get(sessionId);
    if (w && w.lastAppendAt > 0 && now - w.lastAppendAt < 3000) {
      return { triggered: false, reason: 'session busy (mid-turn)' };
    }
    const hint = focusHint?.trim() ? `Next session's focus: ${focusHint.trim()}` : '';

    const spawnTemplate = this.handoffTemplateFor(s, successorProviderId);

    // Idempotent fast-path: a prior handoff already produced a doc but the
    // successor was never spawned (regex miss, sidecar restart, etc.).
    // Skip the prompt injection and jump straight to spawnSuccessor with
    // the existing file. The 30-minute freshness window comes from
    // isReusableDoc — older docs are stale and we'd rather have claude
    // re-summarize.
    const prior = getHandoffRecord(s.node.claudeSessionId);
    if (isReusableDoc(prior) && prior) {
      this.lastHandoffAt.set(sessionId, now);
      this.handoffPendingSince.set(sessionId, now);
      void this.spawnSuccessor(sessionId, prior.handoffPath, spawnTemplate);
      return { triggered: true, reason: 'reused existing handoff doc' };
    }

    // the human's knowledge index dir — the handoff session updates its
    // skills/experiences/knowledge + meta.md here (PART 1 of the prompt).
    const metaDir = ensureHumanMetaDir(s.node.humanId);
    const body = getPrompt('handoff', {
      FOCUS_HINT: hint,
      META_DIR: metaDir,
      SIZE_STATUS: knowledgeSizeStatus(s.node.humanId),
    });
    // bracketed paste: \e[200~ start, \e[201~ end. Modern TUIs (claude
    // included) collapse this into a single visual "pasted" indicator
    // instead of echoing every character as it arrives.
    // Two-phase write: paste block first, then the submit-Enter after a
    // short delay. claude's TUI buffers the paste until end-marker is
    // processed; if we cram \r into the SAME write, the TUI eats it as
    // part of the paste body and the message sits in the input box unsent.
    // 150ms is empirically long enough for the React-style TUI re-render
    // to commit the paste and reopen its keystroke loop.
    this.typeInto(s, `\x1b[200~${body}\x1b[201~`);
    setTimeout(() => this.submitWhenRead(s), 150);
    this.armHandoff(sessionId, s, spawnTemplate, now);
    return { triggered: true };
  }

  switchProvider(
    sessionId: string,
    targetProviderId: ProviderId,
  ): { session: SessionNode; contextPath: string } {
    const old = this.require(sessionId);
    const sourceProviderId = old.node.providerId ?? 'claude';
    if (sourceProviderId === targetProviderId) {
      const err = new Error('target provider is already active') as Error & { code?: string };
      err.code = 'same_provider';
      throw err;
    }
    if (this.isHandingOff(sessionId)) {
      const err = new Error('session is already handing off') as Error & { code?: string };
      err.code = 'handoff_in_flight';
      throw err;
    }

    const sourcePath =
      sourceProviderId === 'cursor'
        ? storeResumePath(sourceProviderId, old.node.cwd, old.node.claudeSessionId)
        : storeTranscriptPath(sourceProviderId, old.node.cwd, old.node.claudeSessionId);
    const native =
      ['claude', 'codex', 'cursor'].includes(sourceProviderId) &&
      ['claude', 'codex', 'cursor'].includes(targetProviderId);
    const spawnTemplate = this.handoffTemplateFor(old, targetProviderId);
    const imported = native
      ? writeNativeSessionImport(
          targetProviderId,
          readNativeMigrationMessages(sourceProviderId, sourcePath),
          old.node.cwd,
        )
      : undefined;
    if (imported)
      preserveImportedSessionName(targetProviderId, imported, spawnTemplate.sessionName ?? '');
    const contextPath = imported?.path ?? writeContinuationBundle(
      {
        providerId: sourceProviderId,
        model: old.node.model,
        cwd: old.node.cwd,
        sessionName:
          storeTitle(sourceProviderId, old.node.cwd, old.node.claudeSessionId) ||
          old.node.sessionName,
        rawTranscriptPath: sourcePath || undefined,
      },
      this.transcript(sessionId),
    );
    const carried =
      sourceProviderId === 'claude' && old.node.claudeSessionId
        ? runningSubagents(old.node.cwd, old.node.claudeSessionId)
        : [];
    const queued =
      sourceProviderId === 'claude' && old.node.claudeSessionId
        ? unhandledQueuedMessagesIn(transcriptPath(old.node.cwd, old.node.claudeSessionId))
        : [];
    const initialPrompt =
      (imported
        ? `The conversation was migrated from ${sourceProviderId} to ${targetProviderId} as native session history. Continue from the latest request without repeating completed work. Historical tool records are already-completed evidence, not calls to execute. The original transcript remains at ${sourcePath || '(not available)'}.`
        : continuationPrompt(contextPath, sourceProviderId, targetProviderId)) +
      queuedCarryoverBlock(queued) +
      (carried.length
        ? `\nSource sub-agents were not transferred across runtimes. Their original transcripts remain beside the source session: ${carried.map((agent) => `${agent.agentId} (${agent.label || agent.task})`).join('; ')}. Inspect their saved results before repeating their work.`
        : '');
    const node = this.spawn({
      ...spawnTemplate,
      providerId: targetProviderId,
      resumeSessionId: imported?.sessionId,
      initialPrompt,
    });

    old.node = { ...old.node, replacedBySessionId: node.sessionId };
    try {
      old.pty?.kill();
    } catch {
      /* already gone */
    }
    const at = new Date().toISOString();
    this.emit('replaced', {
      oldSessionId: sessionId,
      newSessionId: node.sessionId,
      oldClaudeSessionId: old.node.claudeSessionId,
      newClaudeSessionId: node.claudeSessionId,
      handoffPath: contextPath,
      at,
    });
    return { session: node, contextPath };
  }

  /** Everything needed to clone a session into its handoff successor. */
  private handoffTemplateFor(s: Session, successorProviderId?: ProviderId): SpawnArgs {
    return {
      projectId: s.node.projectId,
      projectName: this.projectNames.get(s.node.projectId),
      agentName: s.node.agentName,
      role: s.node.role,
      human: { id: s.node.humanId, name: s.node.humanName, role: s.node.role },
      workspace:
        s.node.workspaceId === 'direct'
          ? undefined
          : { id: s.node.workspaceId, name: s.node.sessionName, root: s.node.cwd },
      directoryless: s.node.workspaceId === 'direct',
      // successor keeps the predecessor's CURRENT display title (user
      // /rename or AI auto-title from the transcript — the stored
      // node.sessionName is just the spawn-time project name). claude
      // re-records it via --name → agent-name, so it survives restarts.
      sessionName:
        storeTitle(s.node.providerId ?? 'claude', s.node.cwd, s.node.claudeSessionId) ||
        s.node.sessionName,
      // #4: the successor runs on the runtime the user picked in the handoff
      // dialog, else inherits the predecessor's (was defaulting to claude — a
      // codex handoff was taken over by claude).
      providerId: successorProviderId ?? s.node.providerId,
      // a chat's backing session hands off like any other; the successor must
      // inherit the chat binding so it stays hidden from the tree and keeps
      // the ateam-chat mount (so it can go on posting to the chat).
      ...(s.node.chatId ? { chat: { chatId: s.node.chatId, humanId: s.node.humanId } } : {}),
    };

  }

  /** Mark a handoff as in flight and arm the output watcher that spawns the
   *  successor once claude reports the doc written. */
  private armHandoff(sessionId: string, s: Session, spawnTemplate: SpawnArgs, now: number): void {
    this.lastHandoffAt.set(sessionId, now);
    this.handoffPendingSince.set(sessionId, now);
    // Persist pending record up front. handoffPath is filled in when the
    // watcher catches claude's marker line.
    upsertHandoffRecord({
      oldClaudeSessionId: s.node.claudeSessionId,
      oldSessionId: sessionId,
      handoffPath: '',
      status: 'pending',
      triggeredAt: new Date(now).toISOString(),
    });
    this.handoffWatch.set(sessionId, {
      window: '',
      spawnTemplate,
    });
  }

  /** Called by the output watcher when claude reports "handoff written:
   *  <path>". Reads the file, spawns a successor session pre-loaded with
   *  the handoff content, and emits session.replaced. */
  private async spawnSuccessor(
    oldSessionId: string,
    handoffPath: string,
    template: SpawnArgs,
  ): Promise<void> {
    // NOTE: we DO NOT pass extraSystemPrompt to the spawn. claude 2.x
    // rejects `--session-id <new-uuid> --append-system-prompt <large>`
    // with "No conversation found with session ID …" — it interprets the
    // combo as a resume of a non-existent session. Instead we spawn a clean
    // fresh session and hand it the handoff content as the FIRST user message
    // via claude's trailing positional `[prompt]` arg — claude submits it
    // itself once its TUI is ready, responds, and takes over. (We used to
    // bracketed-paste it after boot, but that raced the TUI: on a slow boot
    // the paste landed before the input box existed and was silently lost,
    // leaving the successor empty — the exact "no auto-takeover" bug.)
    const handoffMessage = this.buildHandoffMessage(handoffPath);
    if (handoffMessage === undefined) {
      // file missing/unreadable — emit nothing, the user already has
      // the path from the old session's output and can act on it.
      return;
    }
    // what the user queued in the old session and claude never took up dies
    // with its PTY below — hand it to the successor instead
    const old = this.sessions.get(oldSessionId);
    const queued =
      old && (old.node.providerId ?? 'claude') === 'claude' && old.node.claudeSessionId
        ? unhandledQueuedMessagesIn(transcriptPath(old.node.cwd, old.node.claudeSessionId))
        : [];
    // sub-agents still working go with the conversation: listed here, their
    // logs moved once the old process is gone (see subagent-carryover.ts)
    const carried =
      old && (old.node.providerId ?? 'claude') === 'claude' && old.node.claudeSessionId
        ? runningSubagents(old.node.cwd, old.node.claudeSessionId)
        : [];
    const firstMessage =
      handoffMessage + queuedCarryoverBlock(queued) + subagentCarryoverBlock(carried);
    try {
      const node = this.spawn({ ...template, initialPrompt: firstMessage });
      // Successor is up. Mark the handoff "taken_over". The temp doc is
      // intentionally KEPT until the successor proves it took over (its
      // transcript exists) so a crash before the first turn is recoverable
      // on restart — see the recovery branch in spawn().
      const oldSess = this.sessions.get(oldSessionId);
      let oldClaudeSessionId = '';
      if (oldSess) {
        oldClaudeSessionId = oldSess.node.claudeSessionId;
        finalizeTakeover(oldClaudeSessionId, {
          sessionId: node.sessionId,
          claudeSessionId: node.claudeSessionId,
        });
        // Stamp the old node so list()/UI can filter it out of the tree
        // (single-row continuity from the user's POV). The xterm stays
        // mounted in the stage dual-pane for history; the PTY is killed
        // because its conversation is done — claude's TUI exits alt-screen
        // cleanly so the dual-pane top tile no longer shows an input box.
        oldSess.node = { ...oldSess.node, replacedBySessionId: node.sessionId };
        if (carried.length > 0)
          this.moveSubagentsWhenGone(
            oldSess.pty,
            { cwd: oldSess.node.cwd, claudeSessionId: oldClaudeSessionId },
            { cwd: node.cwd, claudeSessionId: node.claudeSessionId },
            carried.map((a) => a.agentId),
          );
        try {
          oldSess.pty?.kill();
        } catch {
          /* already dead */
        }
      }
      this.handoffPendingSince.delete(oldSessionId);
      this.emit('replaced', {
        oldSessionId,
        newSessionId: node.sessionId,
        oldClaudeSessionId,
        newClaudeSessionId: node.claudeSessionId,
        handoffPath,
        at: new Date().toISOString(),
      });
    } catch {
      // spawn failed — leave the doc on disk AND the status as `doc_ready`
      // so the next handoffNow call sees a reusable doc via isReusableDoc
      // and retries spawnSuccessor without asking claude to re-summarize.
      // (We intentionally do NOT flip to `failed` here; that status is
      //  reserved for the 90s-timeout case where claude never produced
      //  a marker line in the first place.)
    }
  }

  reassignHuman(sessionId: string, humanId: string): SessionNode {
    const s = this.require(sessionId);
    const h = getHuman(humanId);
    if (!h) {
      const err = new Error(`no such human: ${humanId}`) as Error & { code?: string };
      err.code = 'not_found';
      throw err;
    }
    s.node = {
      ...s.node,
      humanId: h.id,
      humanName: h.name,
      agentName: h.name,
      role: h.role,
    };
    // record project participation for the NEW human — so their growth /
    // expertise / recall correctly include this workspace going forward.
    // Directory-less sessions don't participate in any specific project.
    if (s.node.workspaceId !== 'direct') {
      recordHumanProject(h.id, s.node.cwd);
    }
    this.emit('status', { sessionId, state: s.state });
    return this.toNode(s);
  }

  /** The stable key a project's display alias is stored under — see
   *  project-alias.ts. A desk group's runtime projectId is a fresh UUID each
   *  launch, so those key off the human instead. */
  private aliasKeyFor(node: Omit<SessionNode, 'state'>): string {
    return node.workspaceId === 'direct' ? `desk:${node.humanId}` : repoGroup(node.cwd).key;
  }

  /** Set (or clear, with '') a project's display alias. Takes the runtime
   *  projectId the UI knows and resolves it to the stable alias key. Returns
   *  false when no live session maps to that project. */
  setProjectAlias(projectId: string, alias: string): boolean {
    for (const s of this.sessions.values()) {
      const group =
        s.node.workspaceId === 'direct'
          ? { key: s.node.projectId }
          : repoGroup(s.node.cwd);
      if (group.key === projectId) {
        setProjectAlias(this.aliasKeyFor(s.node), alias);
        return true;
      }
    }
    return false;
  }

  list(): ProjectTree[] {
    // Group by the REPO (shared across linked worktrees) so a worktree's
    // sessions list under the same project as the primary checkout. This is a
    // display key only — each session keeps its real cwd, so persist/resume
    // still point at the right worktree + transcript.
    const aliases = projectAliases();
    const byProject = new Map<
      string,
      { name: string; alias?: string; sessions: SessionNode[] }
    >();
    for (const s of this.sessions.values()) {
      let node = this.toNode(s);
      // A chat's hidden backing session never appears in the tree — chat mode
      // owns it, and the user is not meant to manage sessions there.
      if (node.chatId) continue;
      // Live-pull the current Human name/role from humans.json so a rename
      // via `human.update` is reflected in tabs immediately — without
      // killing/respawning the PTY. The Claude CLI's internal --name stays
      // whatever it was launched with; only the UI label updates.
      const h = getHuman(node.humanId);
      if (h) {
        node = { ...node, humanName: h.name, agentName: h.name, role: h.role };
      }
      // prefer the CLI's own session name/summary once it exists (claude
      // summary / codex `/rename` thread name)
      const pid = node.providerId ?? 'claude';
      const summary = storeTitle(pid, node.cwd, node.claudeSessionId);
      const createdAt = storeCreatedAt(pid, node.cwd, node.claudeSessionId);
      const lastActiveAt = storeLastActiveAt(pid, node.cwd, node.claudeSessionId);
      const model = storeModel(pid, node.cwd, node.claudeSessionId);
      let enriched: SessionNode = summary ? { ...node, sessionName: summary } : node;
      if (createdAt) enriched = { ...enriched, createdAt };
      if (lastActiveAt) enriched = { ...enriched, lastActiveAt };
      if (model) enriched = { ...enriched, model };
      const pendingAt = this.handoffPendingSince.get(node.sessionId);
      if (pendingAt !== undefined && Date.now() - pendingAt < 10 * 60_000) {
        enriched = { ...enriched, handoffInFlight: true };
      }
      const group =
        node.workspaceId === 'direct'
          ? { key: node.projectId, name: this.projectNames.get(node.projectId) ?? 'project' }
          : repoGroup(node.cwd);
      const entry = byProject.get(group.key) ?? {
        name: group.name,
        // display-only label; `name` stays the real directory-derived one
        // because persistence and spawn grouping key off it.
        alias: aliases[this.aliasKeyFor(node)],
        sessions: [],
      };
      entry.sessions.push(enriched);
      byProject.set(group.key, entry);
    }
    return [...byProject.entries()].map(([projectId, { name, alias, sessions }]) => ({
      projectId,
      name,
      ...(alias ? { alias } : {}),
      sessions,
    }));
  }

  /** Find where a claude session lives NOW. A task (or anything else) that
   *  recorded a claudeSessionId at creation time may be pointing at a
   *  conversation that has since been handed off (successor chain) or
   *  removed from the tree entirely. Resolution order per chain hop:
   *  live/hibernated session in the tree wins; then follow the handoff
   *  successor link; when the chain dries up, check the transcript on disk
   *  (resumable, with the owning human from the session-owners index);
   *  otherwise report why it's gone instead of silently failing. */
  locateClaudeSession(claudeSessionId: string, dir?: string): SessionLocation {
    const liveFor = (cid: string): string | undefined => {
      for (const s of this.sessions.values()) {
        if (s.node.claudeSessionId === cid && !s.node.replacedBySessionId && s.state !== 'exited') {
          return s.node.sessionId;
        }
      }
      return undefined;
    };
    const seen = new Set<string>();
    let cur = claudeSessionId;
    for (;;) {
      const live = liveFor(cur);
      if (live) return { kind: 'live', sessionId: live };
      seen.add(cur);
      const succ = getHandoffRecord(cur)?.successorClaudeSessionId;
      if (!succ || seen.has(succ)) break; // chain end (or a cycle — treat as end)
      cur = succ;
    }
    if (dir && (existsSync(transcriptPath(dir, cur)) || codexRolloutPath(cur))) {
      return { kind: 'resumable', claudeSessionId: cur, dir, humanId: getSessionOwner(cur) };
    }
    const hopped = cur !== claudeSessionId;
    return {
      kind: 'gone',
      reason: hopped
        ? `the newest handoff successor ${cur.slice(0, 8)}… has no transcript on disk anymore`
        : dir
          ? "this session's transcript is no longer on disk"
          : 'the task recorded no project directory — cannot locate the transcript',
    };
  }

  shutdown(): void {
    this.peerWatcher?.close();
    clearInterval(this.peerSweepTimer);
    this.sessionLinksWatcher?.close();
    this.heldInput.clear();
    for (const s of this.sessions.values()) s.pty?.kill();
    this.sessions.clear();
  }

  /** The portable id of the project at `cwd` (docs/sync/design.md §1). An
   *  existing marker is always honoured and indexed; a missing one is created
   *  only with sync on, because it is a file written into the user's project.
   *  Never allowed to fail a spawn. */
  private projectIdentity(cwd: string, name: string): string | undefined {
    try {
      const r = loadConfig().sync.enabled
        ? ensureProjectMarker(cwd, name)
        : findProjectMarker(cwd);
      if (r.kind !== 'found' && r.kind !== 'created') return undefined;
      recordProjectDir(r.marker, r.root);
      return r.marker.id;
    } catch {
      return undefined;
    }
  }

  private require(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) {
      const err = new Error(`no such session: ${sessionId}`) as Error & { code?: string };
      err.code = 'not_found';
      throw err;
    }
    return s;
  }

  private toNode(s: Session): SessionNode {
    return { ...s.node, state: s.state };
  }
}

/** The CLI's input box still shows a paste (collapsed or raw) that was never submitted. */
function pasteInBox(s: { screen?: ScreenMirror }): boolean {
  const rows = s.screen?.rows() ?? [];
  return rows.some((r) => /\[Pasted (text|Content)\b|cross-session-message/.test(r));
}
