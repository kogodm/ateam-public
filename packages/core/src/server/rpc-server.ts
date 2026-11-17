import type { ExternalAccess } from '../external-access';
import type { Duplex } from 'node:stream';
import { type FSWatcher, existsSync, mkdirSync, statSync, watch } from 'node:fs';
import { searchFiles } from '../file-search';
import { hostname } from 'node:os';
import { basename, dirname } from 'node:path';
import {
  type Envelope,
  type EventTopic,
  type ExperienceHit,
  PROTOCOL_VERSION,
  type ProviderId,
  type ReqEnvelope,
  parseEnvelope,
  validateParams,
} from '@ateam/contract';
import { AssetStore, type LlmSynthesizer, type StoredExperience } from '@ateam/knowledge';
import type { Port } from '@ateam/transport';
import { listAppIcons, listOpenerApps, openUrl, openWithApp, revealPath } from '../apps';
import {
  type Chat,
  appendMessage,
  chatFramingPrompt,
  chatLogDir,
  createChat as createChatStore,
  deleteChat as deleteChatStore,
  getChat,
  listChats,
  readMessages,
  recordChatWorkSession,
  updateChat as updateChatStore,
} from '../chat';
import { ChatFloor } from '../chat-floor';
import { runChatResponder } from '../chat-responder';
import { listSlashCommands } from '../claude-commands';
import {
  type AteamConfig,
  DEFAULT_RELAY_BASE_URL,
  finishSetup,
  generateLanPassword,
  hashLanPassword,
  isFirstRun,
  loadConfig,
  machineName,
  recordRole,
  saveConfig,
} from '../config';
import { getFilesLocations, setFilesLocations } from '../files-locations';
import { ClaudeSynthesizer } from '../flywheel/claude-synth';
import { Flywheel } from '../flywheel/flywheel';
import { MetaAgent } from '../flywheel/meta-agent';
import { FsWatchHub } from '../fs-watch';
import {
  createDir,
  firstExistingPath,
  listDir,
  readFileForView,
  saveUpload,
  writeFileText,
} from '../fsview';
import { peekShot } from '../browser/cdp';
import { readAllPlanUsages } from '../plan-usage';
import { readImageThumb } from '../image-thumb';
import { readVideoChunk } from '../video-file';
import { getHumanMarketItem, listHumanMarketItems } from '../human-market';
import {
  ensureHumanMetaDir,
  humanMetaDir,
  humanMetaSummaryInput,
  readHumanMeta,
  readHumanMetaEntries,
  recallFor,
  recallPrompt,
} from '../human-meta';
import {
  ensureHuman,
  getHuman,
  humanDeskDir,
  listHumans,
  migrateHumans,
  projectKeyForDir,
  setHumanSummary,
  updateHuman,
} from '../humans';
import { installationId } from '../installation';
import { ateamHome } from '../paths';
import { listPrompts, promptOverrideDir, resetPromptOverride, setPromptOverride } from '../prompts';
import { listProviders } from '../providers';
import { recentProjects } from '../recent-projects';
import {
  type SavedAgent,
  loadFocusedClaudeSessionId,
  loadSessionState,
  saveSessionState,
} from '../session-state';
import { isRunningAsBackgroundAgent } from '../session/claude-live';
import { listClaudeSessions } from '../session/claude-sessions';
import { isHandedOff } from '../session/handoff-state';
import type { SessionManager } from '../session/manager';
import { storeLastActiveAt } from '../session/provider-store';
import { codexRolloutPath, listCodexThreads } from '../session/providers/codex-sessions';
import { listCursorChats } from '../session/providers/cursor-sessions';
import { estimateTokensFromTranscript } from '../session/token-estimate';
import { transcriptPath, transcriptUsage } from '../session/transcript-file';
import { adoptAllHumansOnce, adoptHumanProjectSkills } from '../skill-adopt';
import { assignSkillUnit, unassignSkillUnit } from '../skill-assignments';
import { entryPathFor, getMarketItem, listMarketItems, resolveMarketSource } from '../skill-market';
import { discoverSources, maybeRunDiscovery } from '../skill-market-discover';
import {
  fetchMarketplace,
  findSkillUnits,
  resolveRemoteSkill,
  validateMarketplace,
} from '../skill-market-remote';
import {
  addSource,
  getSource,
  listSources,
  removeSource,
  setSourceEnabled,
} from '../skill-market-sources';
import { migrateSkillRecords } from '../skill-migrate';
import { discoverSkillSources, discoverSkillUnits } from '../skill-sources';
import { SyncService } from '../sync/service';
import {
  addTask,
  backfillTaskProjectIds,
  claimDueReminders,
  completeTask,
  listTasks,
  removeTask,
  reopenTask,
  tasksFilePath,
} from '../tasks';
import { chatUsageTotals, readUsage } from '../usage-log';
import {
  commitFiles,
  discoverRepos,
  gitBranches,
  gitCheckout,
  gitDiff,
  gitLog,
  gitRemotes,
  gitWorktrees,
  workspaceInfo,
} from '../workspace-info';
import { discoverDevServers } from './dev-servers';
import { LanController } from './lan';
import { RelayClient } from './relay-client';
import { registerWithRelay } from './relay-register';

export interface ServerDeps {
  externalAccess?: ExternalAccess;
  /** serves external MCP requests the relay forwards over the tunnel */
  relayMcp?: (stream: Duplex) => void;
  registerExternal?: (client: 'claude-desktop' | 'chatgpt' | 'cursor-desktop') => {
    path: string;
    restartRequired: boolean;
  };
  sessions: SessionManager;
  /** test seam: inject a deterministic synthesizer / temp store root */
  synth?: LlmSynthesizer;
  storeRoot?: string;
}

function toHit(e: StoredExperience, score?: number): ExperienceHit {
  return {
    id: e.id,
    agentKey: e.agentKey,
    scope: e.scope,
    domain: e.domain,
    title: e.title,
    lessonLearned: e.lessonLearned,
    generalization: e.generalization,
    tags: e.tags,
    appliedCount: e.appliedCount,
    confidence: e.confidence.value,
    ...(score !== undefined ? { score } : {}),
  };
}

/** Config as the UI sees it: the LAN password hash+salt never leave the
 *  sidecar — only whether a password has been set. */
function toConfigDTO(c: AteamConfig): Omit<AteamConfig, 'lan' | 'remote'> & {
  lan: { enabled: boolean; port: number; passwordSet: boolean };
  remote: {
    enabled: boolean;
    url: string;
    deviceId: string;
    tokenSet: boolean;
    tlsFingerprint: string;
    accountId: string;
    email: string;
  };
  machineName: string;
} {
  const { lan, remote, ...rest } = c;
  return {
    ...rest,
    lan: { enabled: lan.enabled, port: lan.port, passwordSet: !!lan.passwordHash },
    remote: {
      enabled: remote.enabled,
      url: remote.url,
      deviceId: remote.deviceId,
      tokenSet: !!remote.token,
      tlsFingerprint: remote.tlsFingerprint,
      accountId: remote.accountId,
      email: remote.email,
    },
    // a client may be a phone tunnelled in from anywhere — tell it which
    // machine it reached, by the same name the machine picker showed
    machineName: machineName(c),
  };
}

export interface RpcServer {
  attach(port: Port): void;
  broadcast(topic: EventTopic, data: unknown, corr?: string): void;
  shutdown(): void;
}

/** Transport-agnostic RPC server. Same instance serves the embedded TUI
 *  (inproc Port) and `ateam serve` (ws Ports) — Tauri later reuses it. */
export function createServer(deps: ServerDeps): RpcServer {
  const { sessions } = deps;
  const ports = new Set<Port>();
  /**
   * Who is driving each session's terminal size.
   *
   * A PTY has exactly one winsize, so a phone and a desktop looking at the same
   * session cannot both have it laid out for them — one of them wins. The rule
   * is "whoever is actually working in it": clients report their size whenever
   * they attach, but that size only reaches the PTY while they hold control.
   * Control is taken by real interaction (session.activate / typing), never by
   * merely connecting — otherwise a phone glancing at a session reflows the
   * desktop to 40 columns and leaves it that way, which is exactly what used
   * to happen.
   */
  const clients = new Map<
    Port,
    {
      sizes: Map<string, { cols: number; rows: number }>;
      viewport?: { cols: number; rows: number };
    }
  >();
  /** sessionId → the port whose size the PTY currently follows */
  const controller = new Map<string, Port>();

  /** Hand a session's size over to `port` and reflow to the size it last
   *  reported — the same thing that happens when a window is dragged wider. */
  function takeControl(sessionId: string, port: Port): void {
    const prev = controller.get(sessionId);
    controller.set(sessionId, port);
    const size = clients.get(port)?.sizes.get(sessionId);
    if (size) sessions.resize(sessionId, size.cols, size.rows);
    if (prev !== port) {
      // tell each side whether it is the one the layout now belongs to, so a
      // passive client can say so instead of just looking broken
      for (const p of ports) {
        p.send({
          v: PROTOCOL_VERSION,
          kind: 'evt',
          topic: 'session.control',
          seq: evtSeq++,
          data: { sessionId, youControl: p === port },
        });
      }
    }
  }
  let evtSeq = 0;

  migrateHumans(); // bake the readable-project-index migration (idempotent)
  const store = new AssetStore(deps.storeRoot ?? ateamHome());
  // corrective: drop global→project dup records, refill stale 总纲 blurbs
  migrateSkillRecords(store);
  // tasks from before project ids existed learn their project's id where the
  // project now has one — off the startup path, since it may call git a few
  // times per project
  setTimeout(() => {
    try {
      backfillTaskProjectIds();
    } catch {
      /* best-effort */
    }
  }, 5_000).unref?.();
  const synth = deps.synth ?? new ClaudeSynthesizer();
  const flywheel = new Flywheel(store, synth);
  // fs.changed push for the file panels — replaces UI-side polling
  const fsWatch = new FsWatchHub((dir, paths) => broadcast('fs.changed', { dir, paths }));
  // ⑦ inject accumulated memory into every newly spawned agent
  // Recall surface is the per-human meta.md knowledge index, maintained by the
  // handoff session itself (see prompts/handoff.txt PART 1): the index plus a
  // load-on-demand directive — no manifest 总纲, no top-N experience dump, no
  // periodic distill. Assembled in core (`recallFor`) so this and the /clear
  // hook inject the same text.
  sessions.setRecall((humanId, cwd, opts) =>
    recallFor(humanId, { cwd, directoryless: opts?.directoryless === true }),
  );

  function broadcast(topic: EventTopic, data: unknown, corr?: string): void {
    const env: Envelope = {
      v: PROTOCOL_VERSION,
      kind: 'evt',
      topic,
      seq: evtSeq++,
      data,
      ...(corr ? { corr } : {}),
    };
    for (const p of ports) p.send(env);
  }

  const accessChanged = () => broadcast('externalMcp.changed', {});
  deps.externalAccess?.on('changed', accessChanged);
  sessions.on('output', (d) => broadcast('session.output', d));
  sessions.on('status', (d) => broadcast('session.status', d));
  sessions.on('turn', (d) => broadcast('session.turn', d));
  sessions.on('externalRun', (d) => broadcast('session.externalRun', d));
  sessions.on('replaced', (d) => {
    broadcast('session.replaced', d);
    // A chat's backing session handed off — follow it: repoint the chat→session
    // map to the successor, then flush any messages the user sent mid-handoff.
    const ev = d as { oldSessionId: string; newSessionId: string };
    for (const [key, sid] of chatSessions) {
      if (sid !== ev.oldSessionId) continue;
      chatSessions.set(key, ev.newSessionId);
      // the successor is a new transcript — keep the chat's bill complete
      const succ = sessions.get(ev.newSessionId);
      const [chatId, humanId] = key.split('::');
      if (succ && chatId && humanId) {
        recordChatWorkSession(chatId, {
          humanId,
          cwd: succ.cwd,
          claudeSessionId: succ.claudeSessionId,
          ...(succ.providerId ? { providerId: succ.providerId } : {}),
        });
      }
      const queued = chatPending.get(key);
      chatPending.delete(key);
      if (queued?.length) {
        // let the successor finish taking over (its first turn is the handoff
        // doc) before the held messages land in its TUI queue
        setTimeout(() => {
          for (const text of queued) {
            sessions.input(ev.newSessionId, `\x1b[200~${text}\x1b[201~`);
            sessions.input(ev.newSessionId, '\r');
          }
        }, 1500);
      }
    }
  });
  // the PTY's winsize — a client whose terminal is hidden (stream view)
  // cannot measure itself and lays its emulator out from this
  sessions.on('resize', (d) => broadcast('session.size', d));

  // ⑤ autonomous flywheel — auto-reflect / distill / decay (no manual R)
  const meta = new MetaAgent(sessions, flywheel);
  meta.on('experience', (d) => broadcast('evolution.experience', d));
  meta.on('skill', (d) => broadcast('evolution.skill', d));
  meta.on('progress', (d) => broadcast('meta.progress', d));
  // Periodic auto-distill is OFF by default now: knowledge consolidation
  // happens at handoff (the handoff session updates its own meta.md +
  // skill/experience/knowledge files). The MetaAgent instance is kept for
  // the manual flywheel.distill RPC. Opt back into the timer with
  // ATEAM_AUTOEVOLVE=1 if you want the old periodic sweep too.
  if (process.env.ATEAM_AUTOEVOLVE === '1') meta.start();

  // Periodic (7-day) LLM web-discovery of new Skill Market sources. Only in the
  // real runtime (no injected synth ⇒ not under test): fire once on boot (gated
  // on the 7-day stamp) and re-check daily. Best-effort — failures swallow and
  // back off via the persisted lastDiscoveryAt.
  let discoveryTimer: ReturnType<typeof setInterval> | undefined;
  if (!deps.synth) {
    // skip the very first-run boot (let the user finish setup before a
    // background headless-claude call); the daily timer picks it up after.
    if (!isFirstRun()) void maybeRunDiscovery(synth as never).catch(() => {});
    discoveryTimer = setInterval(
      () => void maybeRunDiscovery(synth as never).catch(() => {}),
      24 * 60 * 60 * 1000,
    );
    discoveryTimer.unref?.();
  }

  // LAN access (Settings → General): HTTP+WS server on 0.0.0.0 serving the
  // desktop UI + this same RPC surface, password-gated, off by default.
  // Real runtime only — tests must never bind network interfaces.
  // Remote access: outbound tunnel to a self-hosted relay that forwards the
  // relay's public connections into the LAN server below. Constructed first so
  // the LAN server can tell it when the port moves out from under it.
  const relay = deps.synth ? undefined : new RelayClient(deps.relayMcp);
  const lan = deps.synth
    ? undefined
    : new LanController(attach, () => {
        relay?.apply(); // the tunnel dials the LAN port from config — re-dial
      });
  void lan?.apply();
  relay?.apply();
  // cross-device sync (docs/sync/client.md) — real runtime only, like the relay
  const sync = deps.synth
    ? undefined
    : new SyncService({
        clientPort: () => relay?.status().clientPort,
        onSignedOut: () => relay?.apply(),
      });
  sync?.start();
  const needSync = (): SyncService => {
    if (!sync)
      throw Object.assign(new Error('sync is not available here'), { code: 'unavailable' });
    return sync;
  };

  // Task reminders + cross-process task-store sync. Both the desktop and the
  // per-session `ateam-tasks` MCP child (agent side) write ~/.ateam/tasks.json.
  // Watch it so the UI refetches on an agent's change, and poll for due
  // reminders to fire a one-shot `task.due` (→ OS notification + highlight).
  let taskTimer: ReturnType<typeof setInterval> | undefined;
  let taskWatcher: FSWatcher | undefined;
  let chatWatcher: FSWatcher | undefined;
  // per (chat, teammate) → the sessionId currently backing that teammate in
  // that chat. In memory: a restart spawns a fresh backing session on the next
  // message (durable resume + handoff hand-off is a later slice).
  const chatSessions = new Map<string, string>();
  // user messages that arrived while a member's backing session was mid-handoff
  // — flushed to the successor once it comes up (keyed the same way).
  const chatPending = new Map<string, string[]>();

  /** Hand a task to a teammate's WORK session for a chat — spawn one the
   *  first time (hidden, chat-scoped MCP mounted), otherwise inject into the
   *  live session (bracketed paste + a submit Enter, the same two-phase dance
   *  the composer uses). Called only by the floor, with what the teammate's
   *  chat side decided its work side should do. */
  function deliverChatWork(chat: Chat, humanId: string, task: string): void {
    const key = `${chat.id}::${humanId}`;
    const sid = chatSessions.get(key);
    const live = sid ? sessions.get(sid) : undefined;
    const text = `Task from your chat side (chat "${chat.name}"): ${task}`;
    if (!live || live.state === 'exited') {
      const human = getHuman(humanId);
      if (!human) return;
      const directoryless = !chat.workdir;
      const node = sessions.spawn({
        agentName: human.name,
        role: human.role,
        human: { id: human.id, name: human.name, role: human.role },
        ...(directoryless
          ? { directoryless: true }
          : { workspace: { id: `ws-${chat.workdir}`, name: chat.name, root: chat.workdir } }),
        chat: { chatId: chat.id, humanId },
        extraSystemPrompt: chatFramingPrompt(
          chat,
          { name: human.name, role: human.role },
          chat.members
            .filter((m) => m !== humanId)
            .map((m) => {
              const peer = getHuman(m);
              return { name: peer?.name ?? m, role: peer?.role ?? 'teammate' };
            }),
        ),
        initialPrompt: text,
        providerId: human.provider as ProviderId | undefined,
      });
      chatSessions.set(key, node.sessionId);
      recordChatWorkSession(chat.id, {
        humanId,
        cwd: node.cwd,
        claudeSessionId: node.claudeSessionId,
        ...(node.providerId ? { providerId: node.providerId } : {}),
      });
      return;
    }
    if (!sid) return;
    // Mid auto-handoff: hold the task — injecting now would collide with the
    // handoff turn; the 'replaced' handler flushes the queue into the successor.
    if (sessions.isHandingOff(sid)) {
      const q = chatPending.get(key) ?? [];
      q.push(text);
      chatPending.set(key, q);
      return;
    }
    sessions.input(sid, `\x1b[200~${text}\x1b[201~`);
    setTimeout(() => sessions.input(sid, '\r'), 150);
  }

  /** The floor: teammates answer a user message one at a time, lead first.
   *  Each answer is the teammate's chat-side one-shot (same Human, same
   *  knowledge index, none of the work session's context); real work goes to
   *  the work session via deliverChatWork. */
  const chatFloor = new ChatFloor({
    respond(chat, humanId, ctx) {
      const human = getHuman(humanId);
      if (!human) return Promise.resolve(null);
      const sid = chatSessions.get(`${chat.id}::${humanId}`);
      const live = sid ? sessions.get(sid) : undefined;
      const workState =
        !live || live.state === 'exited' ? 'none' : sid && sessions.isBusy(sid) ? 'busy' : 'idle';
      ensureHumanMetaDir(humanId);
      const nameOf = (id: string): string => getHuman(id)?.name ?? id;
      return runChatResponder(
        {
          chat,
          who: { id: human.id, name: human.name, role: human.role },
          peers: chat.members
            .filter((m) => m !== humanId)
            .map((m) => ({ id: m, name: nameOf(m), role: getHuman(m)?.role ?? 'teammate' })),
          isLead: ctx.isLead,
          spokeBefore: ctx.spokeBefore,
          trigger: ctx.trigger,
          recall:
            recallPrompt({ meta: readHumanMeta(humanId), metaDir: humanMetaDir(humanId) }) ?? '',
          workState,
          transcript: readMessages(chat.id),
          cwd: chat.workdir && existsSync(chat.workdir) ? chat.workdir : humanDeskDir(humanId),
        },
        nameOf,
      );
    },
    say(chat, humanId, text) {
      appendMessage({ chatId: chat.id, from: humanId, text });
      broadcast('chat.changed', { chatId: chat.id });
    },
    work(chat, humanId, task) {
      deliverChatWork(chat, humanId, task);
    },
    changed(chatId) {
      broadcast('chat.changed', { chatId });
    },
  });
  if (!deps.synth) {
    const fireDue = (): void => {
      try {
        for (const t of claimDueReminders()) {
          broadcast('task.due', { id: t.id, title: t.title, project: t.project });
        }
      } catch {
        /* store unreadable this tick — try again next interval */
      }
    };
    // mtime fallback: an agent-side change reaches the UI only through the
    // fs.watch below, and macOS FSEvents can drop events — with no second
    // signal the badge/panel would stay stale forever ("sometimes doesn't
    // update" bug). Piggyback on the 15s reminder tick: one stat, and if
    // tasks.json moved since the last look, broadcast task.changed. The
    // watcher stays the fast path; this guarantees convergence ≤15s.
    let lastTasksMtime = 0;
    try {
      lastTasksMtime = statSync(tasksFilePath()).mtimeMs;
    } catch {
      /* store not created yet */
    }
    const syncTasksMtime = (): void => {
      try {
        const m = statSync(tasksFilePath()).mtimeMs;
        if (m !== lastTasksMtime) {
          lastTasksMtime = m;
          broadcast('task.changed', {});
        }
      } catch {
        /* store missing/unreadable this tick */
      }
    };
    fireDue();
    taskTimer = setInterval(() => {
      fireDue();
      syncTasksMtime();
    }, 15_000);
    taskTimer.unref?.();
    try {
      const base = basename(tasksFilePath());
      let deb: ReturnType<typeof setTimeout> | undefined;
      taskWatcher = watch(dirname(tasksFilePath()), (_ev, fn) => {
        if (fn && fn !== base) return; // ignore siblings in ~/.ateam
        clearTimeout(deb);
        deb = setTimeout(() => {
          try {
            // keep the mtime-fallback baseline current so the 15s tick
            // doesn't re-broadcast a change the watcher already delivered
            lastTasksMtime = statSync(tasksFilePath()).mtimeMs;
          } catch {
            /* store missing */
          }
          broadcast('task.changed', {});
        }, 120);
      });
      taskWatcher.unref?.();
    } catch {
      /* fs.watch unsupported here — desktop mutations still push directly */
    }
  }

  // Chat mode: the desktop and each teammate's `ateam-chat` MCP both append to
  // ~/.ateam/chats/<id>.jsonl. Watch the dir so the UI refetches live.
  if (!deps.synth) {
    try {
      mkdirSync(chatLogDir(), { recursive: true });
      let cdeb: ReturnType<typeof setTimeout> | undefined;
      // A teammate's work session delivering a result (chat_say kind:'result'
      // / chat_attach) opens a floor round for the other members — the only
      // way a part that waited on that result gets started. Tracked per chat
      // from server start; the MCP appends from another process, so the log
      // is the one place the event shows up.
      const seenTs = new Map<string, number>();
      const noticeResults = (chatId: string): void => {
        const since = seenTs.get(chatId) ?? Date.now();
        const fresh = readMessages(chatId, since);
        if (!fresh.length) {
          if (!seenTs.has(chatId)) seenTs.set(chatId, since);
          return;
        }
        seenTs.set(chatId, fresh[fresh.length - 1]?.ts ?? since);
        const chat = getChat(chatId);
        if (!chat || chat.kind !== 'group') return;
        for (const m of fresh) {
          if (m.kind === 'result' && m.from !== 'user') chatFloor.peerResult(chat, m.from);
        }
      };
      chatWatcher = watch(chatLogDir(), (_ev, fn) => {
        const chatId = typeof fn === 'string' ? fn.replace(/\.jsonl$/, '') : undefined;
        if (chatId) noticeResults(chatId);
        clearTimeout(cdeb);
        cdeb = setTimeout(() => broadcast('chat.changed', chatId ? { chatId } : {}), 120);
      });
      chatWatcher.unref?.();
    } catch {
      /* fs.watch unsupported — desktop mutations still push directly */
    }
  }

  async function dispatch(method: string, params: unknown, from: Port): Promise<unknown> {
    switch (method) {
      case 'externalMcp.status':
        return deps.externalAccess?.status() ?? { endpoint: '', error: 'External MCP is unavailable in this server.', registered: false, clients: [], pending: [], projects: [] };
      case 'externalMcp.register':
        if (!deps.registerExternal) throw new Error('External MCP registration is unavailable.');
        return deps.registerExternal((params as { client: 'claude-desktop' | 'chatgpt' | 'cursor-desktop' }).client);
      case 'externalMcp.decideRequest': {
        if (!deps.externalAccess) throw new Error('External MCP is unavailable.');
        const p = params as { id: string; allow: boolean };
        deps.externalAccess.decideRequest(p.id, p.allow); return { ok: true };
      }
      case 'externalMcp.decide': {
        if (!deps.externalAccess) throw new Error('External MCP is unavailable.');
        const p = params as { id: string; allow: boolean; projects: string[] };
        deps.externalAccess.decide(p.id, p.allow, p.projects); return { ok: true };
      }
      case 'externalMcp.revoke':
      case 'externalMcp.retry': {
        if (!deps.externalAccess) throw new Error('External MCP is unavailable.');
        const p = params as { id: string };
        if (method === 'externalMcp.revoke') deps.externalAccess.revoke(p.id); else deps.externalAccess.retry(p.id);
        return { ok: true };
      }
      case 'session.spawn': {
        const p = params as Parameters<SessionManager['spawn']>[0];
        // the pane this session is going to appear in belongs to the caller —
        // sizing it to some other client's stage is how a phone's width ended
        // up deciding how wide a desktop session booted
        const vp = clients.get(from)?.viewport;
        const node = sessions.spawn({
          ...p,
          ...(p.cols ? {} : vp ? { cols: vp.cols, rows: vp.rows } : {}),
        });
        if (vp || p.cols) {
          clients.get(from)?.sizes.set(node.sessionId, {
            cols: p.cols ?? vp?.cols ?? 0,
            rows: p.rows ?? vp?.rows ?? 0,
          });
          controller.set(node.sessionId, from); // its creator owns the layout
        }
        return { session: node };
      }
      case 'session.input': {
        const p = params as { sessionId: string; data: string };
        // typing IS using it: take the layout without needing a separate call
        if (controller.get(p.sessionId) !== from) takeControl(p.sessionId, from);
        return sessions.input(p.sessionId, p.data);
      }
      case 'files.search': {
        const p = params as { dir: string; query: string; limit?: number };
        return { paths: await searchFiles(p.dir, p.query, p.limit) };
      }
      case 'session.pullQueue': {
        const p = params as { sessionId: string; clearChars: number };
        if (controller.get(p.sessionId) !== from) takeControl(p.sessionId, from);
        sessions.pullQueue(p.sessionId, p.clearChars);
        return {};
      }
      case 'session.resize': {
        const p = params as { sessionId: string; cols: number; rows: number };
        const c = clients.get(from);
        const before = c?.sizes.get(p.sessionId);
        c?.sizes.set(p.sessionId, { cols: p.cols, rows: p.rows });
        // An attached client reports its size constantly (mount, pane resize,
        // tab switch). Only the one holding the session drives the PTY —
        // otherwise a phone's 40 columns land on the desktop's terminal and
        // stay there. An unclaimed session goes to whoever measured it first.
        const owner = controller.get(p.sessionId);
        if (!owner || !ports.has(owner)) {
          takeControl(p.sessionId, from);
        } else if (owner === from) {
          sessions.resize(p.sessionId, p.cols, p.rows);
        } else if (before && (before.cols !== p.cols || before.rows !== p.rows)) {
          // Someone else holds the layout, but this client's pane just CHANGED
          // size — dragging the divider, resizing the window, rotating a phone.
          // That is a person acting on this screen, so it takes the session the
          // same way typing does. Without this the pane grew locally while the
          // PTY stayed narrow, and the newly exposed columns were never painted
          // by anyone: a blank band down the right of the terminal that nothing
          // could recover, because a drag is not a click and nothing else
          // re-asserted. The FIRST report from a client is deliberately not a
          // change — a phone merely attaching must still not squeeze a desktop.
          takeControl(p.sessionId, from);
        }
        return {};
      }
      case 'session.activate': {
        const p = params as { sessionId: string };
        takeControl(p.sessionId, from);
        return {};
      }
      case 'session.list':
        return { projects: sessions.list() };
      case 'session.kill': {
        const p = params as { sessionId: string };
        sessions.kill(p.sessionId);
        return {};
      }
      case 'session.delete': {
        const p = params as { sessionId: string };
        sessions.delete(p.sessionId);
        return {};
      }
      case 'file.upload': {
        const p = params as { name: string; base64: string };
        return saveUpload(p.name, p.base64);
      }
      case 'session.raw': {
        const p = params as { sessionId: string };
        // the size comes along: replaying a tail into a differently-sized
        // emulator wraps every line, and a stream-view client has no other
        // way to learn how wide the frame it is about to write was drawn
        return { raw: sessions.rawTail(p.sessionId), ...sessions.sizeOf(p.sessionId) };
      }
      case 'claude.commands': {
        const p = params as { sessionId: string };
        return {
          commands: listSlashCommands(
            sessions.cwdOf(p.sessionId),
            sessions.get(p.sessionId)?.providerId,
          ),
        };
      }
      case 'session.transcript': {
        const p = params as { sessionId: string; since?: number };
        return {
          turns: sessions.transcript(p.sessionId, p.since),
          ...sessions.transcriptWindow(p.sessionId),
        };
      }
      case 'session.externalRuns': {
        const p = params as { sessionId: string };
        return { runs: sessions.externalRuns?.(p.sessionId) ?? [] };
      }
      case 'session.bgShells': {
        const p = params as { sessionId: string };
        return { shells: sessions.bgShells(p.sessionId) };
      }
      case 'session.bgShellOutput': {
        const p = params as { sessionId: string; id: string; tailBytes?: number };
        return sessions.bgShellOutput(p.sessionId, p.id, p.tailBytes);
      }
      case 'session.subagents': {
        const p = params as { sessionId: string };
        return { agents: sessions.subagents(p.sessionId) };
      }
      case 'session.subagentTranscript': {
        const p = params as { sessionId: string; agentId: string };
        return { turns: sessions.subagentTranscript(p.sessionId, p.agentId) };
      }
      case 'session.olderTranscript': {
        const p = params as { sessionId: string; beforeByte: number };
        return sessions.transcriptBefore(p.sessionId, p.beforeByte);
      }
      case 'session.reassignHuman': {
        const p = params as { sessionId: string; humanId: string };
        return { session: sessions.reassignHuman(p.sessionId, p.humanId) };
      }
      case 'session.locate': {
        const p = params as { claudeSessionId: string; dir?: string };
        return sessions.locateClaudeSession(p.claudeSessionId, p.dir);
      }
      case 'project.setAlias': {
        const p = params as { projectId: string; alias: string };
        return { ok: sessions.setProjectAlias(p.projectId, p.alias) };
      }
      case 'claude.sessions': {
        const p = params as { cwd?: string; humanId?: string };
        // No directory → the human's directory-less sessions, which all ran
        // in that human's desk dir (see SessionManager.spawn).
        const dir = p.cwd || (p.humanId ? humanDeskDir(p.humanId) : '');
        if (!dir) return { sessions: [] };
        // CLI histories for the dir, newest first
        const merged = [...listClaudeSessions(dir), ...listCodexThreads(dir), ...listCursorChats(dir)].sort((a, b) =>
          a.mtime < b.mtime ? 1 : -1,
        );
        return { sessions: merged };
      }
      case 'flywheel.reflect': {
        const p = params as { sessionId: string };
        const s = sessions.get(p.sessionId);
        if (!s) return { saved: false };
        // directory-less session has no project → global; else a readable
        // project scope (same key the 总纲/adoption use, not a random UUID).
        const direct = s.workspaceId === 'direct';
        const outcome = await flywheel.reflect({
          cwd: s.cwd,
          claudeSessionId: s.claudeSessionId,
          agentKey: s.humanId,
          scope: direct ? 'global' : 'project',
          projectId: direct ? undefined : projectKeyForDir(s.humanId, s.cwd),
          // manual reflect: feed a lot more transcript than the autonomous
          // incremental path, so long design/planning sessions don't lose
          // their early context to truncation.
          maxChars: 60_000,
        });
        for (const exp of outcome.experiences) {
          broadcast('evolution.experience', {
            agentKey: exp.agentKey,
            domain: exp.domain,
            title: exp.title,
            scope: exp.scope,
          });
        }
        for (const sk of outcome.skills) {
          broadcast('evolution.skill', { agentKey: sk.agentKey, source: 'distilled', count: 1 });
        }
        const first = outcome.experiences[0];
        return {
          saved: outcome.experiences.length + outcome.skills.length > 0,
          experience: first ? toHit(first) : undefined,
          counts: {
            experiences: outcome.experiences.length,
            skills: outcome.skills.filter((sk) => sk.kind === 'skill').length,
            knowledge: outcome.skills.filter((sk) => sk.kind === 'knowledge').length,
          },
        };
      }
      case 'asset.search': {
        const p = params as {
          agentKey: string;
          query: string;
          domain?: string;
          projectId?: string;
        };
        const hits = flywheel.recall(p.agentKey, p.query, {
          domain: p.domain,
          projectId: p.projectId,
        });
        return { hits: hits.map((h) => toHit(h.exp, h.score)) };
      }
      case 'agent.growth': {
        const p = params as { agentKey: string };
        return store.growth(p.agentKey);
      }
      case 'human.metaDir': {
        const p = params as { humanId: string };
        return { dir: ensureHumanMetaDir(p.humanId) };
      }
      case 'human.meta': {
        const p = params as { humanId: string };
        return readHumanMetaEntries(p.humanId);
      }
      case 'agent.expertise': {
        const p = params as { agentKey: string };
        return { agentKey: p.agentKey, domains: store.expertise(p.agentKey) };
      }
      case 'usage.recent': {
        const p = params as { limit?: number };
        return readUsage(p.limit ?? 200);
      }
      case 'provider.list':
        return { providers: listProviders() };
      case 'app.list':
        return { apps: listOpenerApps() };
      case 'app.icons':
        return { icons: await listAppIcons() };
      case 'app.openPath': {
        const p = params as { appName: string; path: string; cwd?: string };
        return await openWithApp(p.appName, p.path, p.cwd);
      }
      case 'dir.list': {
        const p = params as { path: string };
        return listDir(p.path);
      }
      case 'files.locations': {
        const p = params as { scope: string };
        return { locations: getFilesLocations(p.scope) };
      }
      case 'files.setLocations': {
        const p = params as { scope: string; locations: string[] };
        return { locations: setFilesLocations(p.scope, p.locations ?? []) };
      }
      case 'file.read': {
        const p = params as { path: string };
        return readFileForView(p.path);
      }
      case 'file.videoChunk': {
        return readVideoChunk(params as { path: string; offset: number; length: number; version?: string });
      }
      case 'file.thumb': {
        const p = params as { path: string; max?: number };
        return await readImageThumb(p.path, p.max);
      }
      case 'browser.shot': {
        const p = params as { sessionId: string; width?: number };
        return (await peekShot(p.sessionId, p.width).catch(() => undefined)) ?? null;
      }
      case 'file.write': {
        const p = params as { path: string; text: string };
        return writeFileText(p.path, p.text);
      }
      case 'sessionState.get':
        return {
          // enrich with the transcript's last real activity so restore can
          // decide live-boot vs hibernate per session. A session that was
          // handed off to a successor is dropped here no matter how it got
          // into the file: restoring it would put the finished predecessor
          // next to the live successor as two tabs of one conversation.
          agents: loadSessionState()
            .filter((a) => !isHandedOff(a.claudeSessionId))
            .map((a) => {
              // legacy entries (saved before providerId existed) that point at a
              // codex thread: infer the runtime from where the transcript lives.
              const providerId =
                a.providerId ??
                (!existsSync(transcriptPath(a.dir, a.claudeSessionId)) &&
                codexRolloutPath(a.claudeSessionId)
                  ? 'codex'
                  : 'claude');
              const at = storeLastActiveAt(providerId, a.dir, a.claudeSessionId);
              const enriched = providerId === 'claude' && !a.providerId ? a : { ...a, providerId };
              // Already running as a background agent? Then it is not ours to
              // resume — restore registers the row and boots nothing.
              const bg = isRunningAsBackgroundAgent(a.claudeSessionId);
              const withAt = at ? { ...enriched, lastActiveAt: at } : enriched;
              return bg ? { ...withAt, backgroundAgent: true } : withAt;
            }),
          focusedClaudeSessionId: loadFocusedClaudeSessionId(),
        };
      case 'sessionState.set': {
        const p = params as { agents: SavedAgent[]; focusedClaudeSessionId?: string };
        saveSessionState(p.agents, p.focusedClaudeSessionId);
        return {};
      }
      case 'skill.sources': {
        const p = params as { projectDir?: string };
        return { sources: discoverSkillSources(p.projectDir ?? process.cwd()) };
      }
      case 'skill.units': {
        const p = params as { projectDir?: string };
        return { units: discoverSkillUnits(p.projectDir ?? process.cwd()) };
      }
      case 'skill.importUnit': {
        const p = params as {
          humanId: string;
          unitPath: string;
          kind: 'file' | 'bundle' | 'tree';
          entry: string;
          scope?: 'project' | 'global';
        };
        const human = getHuman(p.humanId);
        const imported = flywheel.importSkillUnit(
          p.humanId,
          p.unitPath,
          p.kind,
          p.entry,
          p.scope ?? 'global',
        );
        if (imported > 0) {
          assignSkillUnit(p.unitPath, p.humanId, human?.name ?? p.humanId);
          broadcast('evolution.skill', {
            agentKey: p.humanId,
            source: 'user_provided',
            count: imported,
          });
        }
        return { imported };
      }
      case 'skill.adoptHumanDirs': {
        const p = params as { humanId?: string; all?: boolean };
        const r = p.all
          ? adoptAllHumansOnce(flywheel)
          : p.humanId
            ? adoptHumanProjectSkills(flywheel, p.humanId)
            : { adopted: 0, dirs: 0 };
        if (r.adopted > 0)
          broadcast('evolution.skill', {
            agentKey: p.humanId ?? 'all',
            source: 'user_provided',
            count: r.adopted,
          });
        return { adopted: r.adopted, dirs: r.dirs };
      }
      case 'skill.import': {
        const p = params as { agentKey: string; dir: string; scope?: 'project' | 'global' };
        const imported = flywheel.importSkillsFromDir(p.agentKey, p.dir, p.scope ?? 'global');
        if (imported > 0)
          broadcast('evolution.skill', {
            agentKey: p.agentKey,
            source: 'user_provided',
            count: imported,
          });
        return { imported };
      }
      case 'skill.learn': {
        const p = params as { agentKey: string; projectDir: string; scope?: 'project' | 'global' };
        const learned = await flywheel.learnFromProject(
          p.agentKey,
          p.projectDir,
          p.scope ?? 'global',
        );
        if (learned > 0)
          broadcast('evolution.skill', { agentKey: p.agentKey, source: 'learned', count: learned });
        return { learned };
      }
      case 'meta.runNow':
        return meta.runNow();
      case 'project.recent':
        return { dirs: recentProjects() };
      case 'workspace.info': {
        const p = params as { dir: string; fresh?: boolean };
        return { info: workspaceInfo(p.dir, p.fresh) };
      }
      case 'workspace.repos': {
        const p = params as { dir: string };
        return { repos: discoverRepos(p.dir) };
      }
      case 'fs.watch': {
        const p = params as { dir: string };
        return { ok: fsWatch.watchDir(p.dir) };
      }
      case 'fs.unwatch': {
        const p = params as { dir: string };
        fsWatch.unwatchDir(p.dir);
        return {};
      }
      case 'workspace.gitLog': {
        const p = params as { dir: string; limit?: number };
        return { commits: gitLog(p.dir, p.limit) };
      }
      case 'workspace.commitFiles': {
        const p = params as { dir: string; hash: string };
        return { files: commitFiles(p.dir, p.hash) };
      }
      case 'workspace.diff': {
        const p = params as { dir: string; path: string; hash?: string };
        return gitDiff(p.dir, p.path, p.hash);
      }
      case 'workspace.remotes': {
        const p = params as { dir: string };
        return { remotes: gitRemotes(p.dir) };
      }
      case 'workspace.branches': {
        const p = params as { dir: string };
        return gitBranches(p.dir);
      }
      case 'workspace.checkout': {
        const p = params as { dir: string; branch: string };
        return gitCheckout(p.dir, p.branch);
      }
      case 'workspace.worktrees': {
        const p = params as { dir: string };
        return { worktrees: gitWorktrees(p.dir) };
      }
      case 'path.reveal': {
        const p = params as { path: string };
        return await revealPath(p.path);
      }
      case 'path.firstExisting': {
        const p = params as { paths: string[] };
        return firstExistingPath(p.paths);
      }
      case 'path.resolve': {
        const p = params as { sessionId: string; ref: string; roots?: string[] };
        return sessions.resolvePath(p.sessionId, p.ref, p.roots ?? []);
      }
      case 'path.createDir': {
        const p = params as { parent: string; name: string };
        return createDir(p.parent, p.name);
      }
      case 'task.list': {
        const p = params as { project?: string; status?: 'open' | 'done' };
        return { tasks: listTasks(p) };
      }
      case 'task.add': {
        const p = params as {
          title: string;
          body?: string;
          project?: string;
          remindAt?: number;
          tags?: string[];
        };
        const task = addTask({ ...p, source: 'user' });
        broadcast('task.changed', {});
        return { task };
      }
      case 'task.complete': {
        const p = params as { id: string };
        const ok = completeTask(p.id) !== null;
        if (ok) broadcast('task.changed', {});
        return { ok };
      }
      case 'task.reopen': {
        const p = params as { id: string };
        const ok = reopenTask(p.id) !== null;
        if (ok) broadcast('task.changed', {});
        return { ok };
      }
      case 'task.remove': {
        const p = params as { id: string };
        const ok = removeTask(p.id);
        if (ok) broadcast('task.changed', {});
        return { ok };
      }
      case 'chat.list':
        return { chats: listChats() };
      case 'chat.create': {
        const p = params as {
          kind: 'dm' | 'group';
          name: string;
          members: string[];
          workdir?: string;
          purpose?: string;
        };
        // A DM (one teammate) with no workdir is directory-less — the
        // teammate's desk dir; a group carries the picked project dir.
        const chat = createChatStore({
          kind: p.kind,
          name: p.name,
          members: p.members,
          workdir: p.workdir ?? '',
          purpose: p.purpose,
        });
        broadcast('chat.changed', { chatId: chat.id });
        return { chat };
      }
      case 'chat.update': {
        const p = params as {
          chatId: string;
          name?: string;
          members?: string[];
          workdir?: string;
          purpose?: string;
        };
        const chat = updateChatStore(p.chatId, p) ?? null;
        if (chat) broadcast('chat.changed', { chatId: chat.id });
        return { chat };
      }
      case 'chat.delete': {
        const p = params as { chatId: string };
        deleteChatStore(p.chatId);
        broadcast('chat.changed', { chatId: p.chatId });
        return { ok: true };
      }
      case 'chat.messages': {
        const p = params as { chatId: string; sinceTs?: number };
        return {
          messages: readMessages(p.chatId, p.sinceTs ?? 0),
          typing: chatFloor.typingIn(p.chatId),
        };
      }
      case 'chat.usage': {
        const p = params as { chatId: string };
        const chat = getChat(p.chatId);
        const work = {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
        };
        for (const w of chat?.workSessions ?? []) {
          const u = transcriptUsage(w.cwd, w.claudeSessionId);
          work.calls += u.turns;
          work.inputTokens += u.inputTokens;
          work.outputTokens += u.outputTokens;
          work.cacheReadTokens += u.cacheReadTokens;
          work.cacheCreationTokens += u.cacheCreationTokens;
          work.costUsd += u.costUsd;
        }
        const chatSide = chatUsageTotals(p.chatId);
        const sum = (b: typeof work): number =>
          b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens;
        return {
          total: sum(chatSide) + sum(work),
          costUsd: chatSide.costUsd + work.costUsd,
          chat: chatSide,
          work,
        };
      }
      case 'chat.send': {
        const p = params as { chatId: string; text: string };
        const chat = getChat(p.chatId);
        if (!chat) return { message: null };
        const message = appendMessage({ chatId: p.chatId, from: 'user', text: p.text });
        broadcast('chat.changed', { chatId: p.chatId });
        // Teammates take the floor one at a time (lead first) and answer
        // through their chat side; nothing is pushed into a work session here.
        chatFloor.userSaid(chat);
        return { message };
      }
      case 'url.open': {
        const p = params as { url: string };
        return await openUrl(p.url);
      }
      case 'human.list':
        return { humans: listHumans() };
      case 'human.create': {
        const p = params as { name: string; role: string; provider?: string; notes?: string };
        const h = ensureHuman({ name: p.name, role: p.role, provider: p.provider });
        return { human: h };
      }
      case 'human.get': {
        const p = params as { id: string };
        return { human: getHuman(p.id) ?? null };
      }
      case 'human.update': {
        const p = params as {
          id: string;
          patch: {
            name?: string;
            role?: string;
            provider?: string;
            notes?: string;
            avatarId?: string;
            model?: string;
            duties?: string;
          };
        };
        const h = updateHuman(p.id, p.patch);
        if (!h) {
          const err = new Error(`no such human: ${p.id}`) as Error & { code?: string };
          err.code = 'not_found';
          throw err;
        }
        return { human: h };
      }
      case 'human.summarize': {
        const p = params as { id: string };
        const h = getHuman(p.id);
        if (!h) {
          const err = new Error(`no such human: ${p.id}`) as Error & { code?: string };
          err.code = 'not_found';
          throw err;
        }
        // Input comes from the LIVE memory system — the human's meta
        // knowledge base (meta.md + skills/knowledge/experiences files).
        // It used to read the AssetStore experience DB, which is frozen:
        // every human whose knowledge was written after the switch looked
        // empty there, so the model was handed a blank input and dutifully
        // answered "暂无足够记录。" for people with a full meta.md.
        const input = humanMetaSummaryInput(p.id);
        // Nothing accumulated yet → don't spend an LLM call asking it to
        // summarize emptiness; the card already says so.
        if (!input) return { human: h };
        // best-effort: summarize() returns '' on CLI failure/timeout → keep existing.
        const synthForSummary = synth as { summarize?: (s: string) => Promise<string> };
        let text = '';
        if (typeof synthForSummary.summarize === 'function') {
          try {
            text = await synthForSummary.summarize(input);
          } catch {
            text = '';
          }
        }
        if (!text) return { human: h }; // CLI failed → return existing (incl. prior summary)
        const updated = setHumanSummary(p.id, { text, at: new Date().toISOString() });
        return { human: updated ?? h };
      }
      case 'skill.unassign': {
        const p = params as { humanId: string; unitPath: string };
        const removed = unassignSkillUnit(p.unitPath, p.humanId);
        // also drop the per-human vault entry + asset-store record so the
        // skill no longer ships in the next spawn's manifest
        flywheel.unassignSkillUnit(p.humanId, p.unitPath);
        return { removed };
      }
      case 'flywheel.distill': {
        const p = params as { humanId: string };
        return await meta.runForHuman(p.humanId);
      }
      case 'skill.market.list': {
        const p = params as { sourceId?: string; query?: string; limit?: number };
        const sourceId = p.sourceId ?? 'builtin';
        let all: Awaited<ReturnType<typeof fetchMarketplace>>;
        if (sourceId === 'builtin') {
          all = listMarketItems();
        } else {
          const src = getSource(sourceId);
          if (!src || src.kind !== 'marketplace') {
            const err = new Error(`unknown source: ${sourceId}`) as Error & { code?: string };
            err.code = 'not_found';
            throw err;
          }
          all = await fetchMarketplace(src);
        }
        const q = (p.query ?? '').trim().toLowerCase();
        const filtered = q
          ? all.filter((i) =>
              `${i.name} ${i.description} ${i.author ?? ''} ${i.tags.join(' ')}`
                .toLowerCase()
                .includes(q),
            )
          : all;
        const items = p.limit && p.limit > 0 ? filtered.slice(0, p.limit) : filtered;
        return { items, total: filtered.length, sourceId };
      }
      case 'skill.market.sources':
        return { sources: listSources() };
      case 'skill.market.addSource': {
        const p = params as { repo: string };
        // reject before persisting unless it exposes a parseable marketplace.json
        await validateMarketplace(p.repo);
        return { source: addSource({ repo: p.repo }) };
      }
      case 'skill.market.removeSource': {
        const p = params as { id: string };
        return { removed: removeSource(p.id) };
      }
      case 'skill.market.setSourceEnabled': {
        const p = params as { id: string; enabled: boolean };
        const source = setSourceEnabled(p.id, p.enabled);
        if (!source) {
          const err = new Error(`unknown source: ${p.id}`) as Error & { code?: string };
          err.code = 'not_found';
          throw err;
        }
        return { source };
      }
      case 'skill.market.discover': {
        const added = await discoverSources(synth as never);
        return { added };
      }
      case 'skill.market.install': {
        const p = params as { humanId: string; itemId: string; sourceId?: string };
        const sourceId = p.sourceId ?? 'builtin';
        const human = getHuman(p.humanId);
        const name = human?.name ?? p.humanId;
        let imported = 0;
        if (sourceId === 'builtin') {
          const item = getMarketItem(p.itemId);
          if (!item) {
            const err = new Error(`unknown market item: ${p.itemId}`) as Error & { code?: string };
            err.code = 'not_found';
            throw err;
          }
          const dir = await resolveMarketSource(item);
          // importSkillUnit wants the DIR for tree/bundle units (it symlinks
          // the dir and reads <dir>/<entry> for the body) and the file itself
          // for 'file' units. Passing the entry file for a tree unit silently
          // stored an empty "SKILL" placeholder — that is the unit-path here.
          const unitPath = item.kind === 'file' ? entryPathFor(dir, item) : dir;
          imported = flywheel.importSkillUnit(p.humanId, unitPath, item.kind, item.entry, 'global');
          if (imported > 0) assignSkillUnit(unitPath, p.humanId, name);
        } else {
          const src = getSource(sourceId);
          if (!src || src.kind !== 'marketplace') {
            const err = new Error(`unknown source: ${sourceId}`) as Error & { code?: string };
            err.code = 'not_found';
            throw err;
          }
          const items = await fetchMarketplace(src);
          const item = items.find((i) => i.id === p.itemId);
          if (!item) {
            const err = new Error(`unknown market item: ${p.itemId}`) as Error & { code?: string };
            err.code = 'not_found';
            throw err;
          }
          // fetch-on-install: git-clone the plugin, import each SKILL.md unit
          const base = await resolveRemoteSkill(item);
          for (const unit of findSkillUnits(base)) {
            const n = flywheel.importSkillUnit(p.humanId, unit, 'tree', 'SKILL.md', 'global');
            if (n > 0) {
              assignSkillUnit(unit, p.humanId, name);
              imported += n;
            }
          }
        }
        if (imported > 0) {
          broadcast('evolution.skill', {
            agentKey: p.humanId,
            source: 'user_provided',
            count: imported,
          });
        }
        return { imported };
      }
      case 'human.market.list':
        return { items: listHumanMarketItems() };
      case 'human.market.hire': {
        const p = params as { itemId: string; name?: string };
        const item = getHumanMarketItem(p.itemId);
        if (!item) {
          const err = new Error(`unknown market human: ${p.itemId}`) as Error & {
            code?: string;
          };
          err.code = 'not_found';
          throw err;
        }
        // A prefab may be hired more than once (e.g. two backend engineers);
        // ensureHuman dedupes by (name,role), so disambiguate the name first.
        const existing = listHumans();
        const base = (p.name ?? item.name).trim() || item.title;
        let name = base;
        for (let n = 2; existing.some((h) => h.name === name && h.role === item.role); n++) {
          name = `${base} ${n}`;
        }
        const human = ensureHuman({ name, role: item.role });
        // Suggested avatar, only if free — avatars are mutually exclusive.
        if (item.avatarId && !existing.some((h) => h.avatarId === item.avatarId)) {
          updateHuman(human.id, { avatarId: item.avatarId });
        }
        // Install each built-in skill via the same path skill.market.install uses.
        let installedSkills = 0;
        for (const sid of item.skillIds) {
          const skill = getMarketItem(sid);
          if (!skill) continue;
          try {
            const dir = await resolveMarketSource(skill);
            // dir for tree/bundle units, the entry file only for 'file' units
            const unitPath = skill.kind === 'file' ? entryPathFor(dir, skill) : dir;
            const imported = flywheel.importSkillUnit(
              human.id,
              unitPath,
              skill.kind,
              skill.entry,
              'global',
            );
            if (imported > 0) {
              assignSkillUnit(unitPath, human.id, name);
              installedSkills += 1;
            }
          } catch {
            /* best-effort per skill: a missing bundle must not abort the hire */
          }
        }
        if (installedSkills > 0) {
          broadcast('evolution.skill', {
            agentKey: human.id,
            source: 'user_provided',
            count: installedSkills,
          });
        }
        return { human: getHuman(human.id) ?? human, installedSkills };
      }
      case 'config.get':
        return { firstRun: isFirstRun(), config: toConfigDTO(loadConfig()) };
      case 'prompts.list':
        return { prompts: listPrompts(), overrideDir: promptOverrideDir() };
      case 'prompts.set': {
        const p = params as { name: string; text: string };
        return setPromptOverride(p.name, p.text);
      }
      case 'prompts.reset': {
        const p = params as { name: string };
        resetPromptOverride(p.name);
        return {};
      }
      case 'config.markRole': {
        const p = params as { role: string; skillDir?: string; learnedProject?: string };
        recordRole(p.role, { skillDir: p.skillDir, learnedProject: p.learnedProject });
        return {};
      }
      case 'config.finish':
        finishSetup();
        return {};
      case 'config.set': {
        const p = params as {
          codegraph?: boolean;
          autoResume?: boolean;
          desktopView?: 'terminal' | 'stream';
          autoHandoff?: { enabled?: boolean; thresholdTokens?: number };
          experienceCheckpoint?: { enabled?: boolean; thresholdTokens?: number };
          proxy?: { enabled?: boolean; url?: string };
          hibernate?: { enabled?: boolean; idleHours?: number };
          lan?: { enabled?: boolean; port?: number; password?: string };
          remote?: {
            enabled?: boolean;
            url?: string;
            deviceId?: string;
            token?: string;
            tlsFingerprint?: string;
          };
        };
        const cur = loadConfig();
        const lanNext = {
          ...cur.lan,
          enabled: p.lan?.enabled ?? cur.lan.enabled,
          port: p.lan?.port ?? cur.lan.port,
          ...(p.lan?.password ? hashLanPassword(p.lan.password) : {}),
        };
        if (lanNext.enabled && !lanNext.passwordHash) {
          const err = new Error('set a LAN password before enabling LAN access') as Error & {
            code?: string;
          };
          err.code = 'lan_password_required';
          throw err;
        }
        const next = {
          ...cur,
          codegraph: p.codegraph ?? cur.codegraph,
          autoResume: p.autoResume ?? cur.autoResume,
          desktopView: p.desktopView ?? cur.desktopView,
          autoHandoff: {
            enabled: p.autoHandoff?.enabled ?? cur.autoHandoff.enabled,
            thresholdTokens: p.autoHandoff?.thresholdTokens ?? cur.autoHandoff.thresholdTokens,
          },
          experienceCheckpoint: {
            enabled: p.experienceCheckpoint?.enabled ?? cur.experienceCheckpoint.enabled,
            thresholdTokens:
              p.experienceCheckpoint?.thresholdTokens ?? cur.experienceCheckpoint.thresholdTokens,
          },
          proxy: {
            enabled: p.proxy?.enabled ?? cur.proxy.enabled,
            url: p.proxy?.url ?? cur.proxy.url,
          },
          hibernate: {
            enabled: p.hibernate?.enabled ?? cur.hibernate.enabled,
            idleHours: p.hibernate?.idleHours ?? cur.hibernate.idleHours,
          },
          lan: lanNext,
          remote: {
            enabled: p.remote?.enabled ?? cur.remote.enabled,
            url: p.remote?.url?.trim() ?? cur.remote.url,
            deviceId: p.remote?.deviceId?.trim() ?? cur.remote.deviceId,
            token: p.remote?.token?.trim() ?? cur.remote.token,
            tlsFingerprint: p.remote?.tlsFingerprint?.trim() ?? cur.remote.tlsFingerprint,
            name: cur.remote.name, // set at registration, not editable here
            accountId: cur.remote.accountId,
            email: cur.remote.email,
          },
        };
        saveConfig(next);
        if (p.lan) await lan?.apply();
        if (p.lan || p.remote) relay?.apply();
        return { config: toConfigDTO(next) };
      }
      case 'remote.register': {
        const p = params as {
          baseUrl: string;
          email: string;
          password: string;
          name: string;
          tlsFingerprint?: string;
          invite?: string;
        };
        const r = await registerWithRelay({ ...p, installationId: installationId() });
        const cur = loadConfig();
        saveConfig({
          ...cur,
          remote: {
            enabled: true,
            url: r.agentUrl,
            deviceId: r.deviceId,
            token: r.token,
            tlsFingerprint: p.tlsFingerprint?.trim() ?? '',
            name: p.name.trim() || hostname(),
            accountId: r.accountId,
            email: r.email,
          },
        });
        relay?.apply();
        return { deviceId: r.deviceId, agentUrl: r.agentUrl };
      }
      case 'remote.signIn': {
        const p = params as {
          email: string;
          password: string;
          name?: string;
          baseUrl?: string;
          invite?: string;
        };
        const cur = loadConfig();
        // the relay address is built in; a previous registration's host wins so
        // a machine already pointed elsewhere stays pointed there
        const known = cur.remote.url.replace(/^wss?:\/\//, '').replace(/[:/].*$/, '');
        const baseUrl =
          p.baseUrl?.trim() ||
          (known
            ? `https://${known}:${new URL(DEFAULT_RELAY_BASE_URL).port}`
            : DEFAULT_RELAY_BASE_URL);
        // 1) credentials FIRST — a typo must not leave LAN access switched on
        const deviceName = p.name?.trim() || hostname();
        const r = await registerWithRelay({
          baseUrl,
          email: p.email,
          password: p.password,
          name: deviceName,
          tlsFingerprint: cur.remote.tlsFingerprint,
          installationId: installationId(),
          ...(p.invite ? { invite: p.invite } : {}),
        });
        // 2) LAN access carries the tunnel, and refuses to run without a
        //    password — mint one rather than sending the user to another pane
        let lanPassword: string | undefined;
        let lanCfg = cur.lan;
        if (!lanCfg.passwordHash) {
          lanPassword = generateLanPassword();
          lanCfg = { ...lanCfg, ...hashLanPassword(lanPassword) };
        }
        saveConfig({
          ...loadConfig(),
          lan: { ...lanCfg, enabled: true },
          remote: {
            enabled: true,
            url: r.agentUrl,
            deviceId: r.deviceId,
            token: r.token,
            tlsFingerprint: cur.remote.tlsFingerprint,
            // kept so every client can SAY which machine it reached — the
            // relay knew this name, this machine did not
            name: deviceName,
            accountId: r.accountId,
            email: r.email,
          },
        });
        await lan?.apply();
        relay?.apply();
        const host = r.agentUrl.replace(/^wss?:\/\//, '').replace(/[:/].*$/, '');
        return {
          deviceId: r.deviceId,
          publicUrl: `https://${host}:${new URL(baseUrl).port || 443}`,
          ...(lanPassword ? { lanPassword } : {}),
        };
      }
      case 'sync.status':
        return needSync().status();
      case 'sync.enable':
        return needSync().enable((params as { passphrase: string }).passphrase);
      case 'sync.disable':
        return needSync().disable();
      case 'sync.now':
        return needSync().now();
      case 'sync.changePassphrase': {
        const p = params as { current: string; next: string };
        await needSync().changePassphrase(p.current, p.next);
        return {};
      }
      case 'sync.devices':
        return { devices: await needSync().devices() };
      case 'remote.createInvite': {
        const p = params as { uses?: number; days?: number };
        return needSync().createInvite(p.uses, p.days);
      }
      case 'sync.renameDevice': {
        const p = params as { id: string; name: string };
        await needSync().renameDevice(p.id, p.name);
        return {};
      }
      case 'sync.revokeDevice':
        await needSync().revokeDevice((params as { id: string }).id);
        return {};
      case 'remote.status': {
        if (relay) return relay.status();
        return { enabled: false, connected: false, url: '', deviceId: '' };
      }
      case 'preview.servers': {
        return { servers: await discoverDevServers([loadConfig().lan.port]) };
      }
      case 'preview.allow': {
        const p = params as { port: number };
        // Re-discover rather than trust the number: the picker's list may be
        // seconds old, and only something that IS a local web page right now
        // may be opened to the tunnel.
        const found = (await discoverDevServers([loadConfig().lan.port])).find(
          (s) => s.port === p.port,
        );
        if (!found) return { ok: false, port: p.port, err: 'no web server is listening there' };
        await relay?.allowPreview(found.port, found.host);
        return { ok: true, port: found.port, host: found.host };
      }
      case 'lan.status': {
        if (lan) return lan.status();
        const c = loadConfig().lan;
        return {
          running: false,
          enabled: c.enabled,
          passwordSet: !!c.passwordHash,
          port: c.port,
          urls: [],
        };
      }
      case 'session.estimateTokens': {
        const p = params as { sessionId: string };
        const node = sessions.get(p.sessionId);
        if (!node) {
          const err = new Error(`no such session: ${p.sessionId}`) as Error & { code?: string };
          err.code = 'not_found';
          throw err;
        }
        return estimateTokensFromTranscript(
          node.cwd,
          node.claudeSessionId,
          node.providerId ?? 'claude',
        );
      }
      case 'session.hibernate': {
        const p = params as { sessionId: string };
        sessions.hibernate(p.sessionId);
        return {};
      }
      case 'session.wake': {
        const p = params as { sessionId: string; fork?: boolean };
        return { session: sessions.wake(p.sessionId, { fork: p.fork === true }) };
      }
      case 'session.addHibernated': {
        const p = params as {
          projectName: string;
          agentName: string;
          role: string;
          dir: string;
          claudeSessionId: string;
          directoryless?: boolean;
          providerId?: ProviderId;
        };
        return { session: sessions.addHibernated(p) };
      }
      case 'usage.plan': {
        const p = params as { sessionId: string };
        const node = sessions.get(p.sessionId);
        const rollout =
          node?.providerId === 'codex' ? codexRolloutPath(node.claudeSessionId) : undefined;
        return { plans: await readAllPlanUsages({ codexRolloutPath: rollout }) };
      }
      case 'session.usage': {
        const p = params as { sessionId: string };
        const node = sessions.get(p.sessionId);
        if (!node) {
          const err = new Error(`no such session: ${p.sessionId}`) as Error & { code?: string };
          err.code = 'not_found';
          throw err;
        }
        return transcriptUsage(node.cwd, node.claudeSessionId);
      }
      case 'session.viewport': {
        const p = params as { cols: number; rows: number };
        const c = clients.get(from);
        if (c) c.viewport = { cols: p.cols, rows: p.rows };
        // keep the manager's fallback current too (single-client case)
        sessions.setViewport(p.cols, p.rows);
        return {};
      }
      case 'session.handoffNow': {
        const p = params as {
          sessionId: string;
          focusHint?: string;
          successorProviderId?: ProviderId;
        };
        return sessions.handoffNow(p.sessionId, p.focusHint, p.successorProviderId);
      }
      case 'session.switchProvider': {
        const p = params as { sessionId: string; targetProviderId: ProviderId };
        return sessions.switchProvider(p.sessionId, p.targetProviderId);
      }
      default: {
        const err = new Error(`unknown method: ${method}`) as Error & { code?: string };
        err.code = 'unknown_method';
        throw err;
      }
    }
  }

  function errRes(id: string, code: string, message: string): Envelope {
    return { v: PROTOCOL_VERSION, kind: 'res', id, ok: false, error: { code, message } };
  }

  function attach(port: Port): void {
    ports.add(port);
    clients.set(port, { sizes: new Map() });
    port.onMessage(async (raw) => {
      let env: Envelope;
      try {
        env = parseEnvelope(raw);
      } catch {
        return; // unparseable: no id to correlate, drop
      }
      if (env.kind !== 'req') return;
      const req = env as ReqEnvelope;
      try {
        const params = validateParams(req.method, req.params);
        const result = await dispatch(req.method, params, port);
        port.send({ v: PROTOCOL_VERSION, kind: 'res', id: req.id, ok: true, result });
      } catch (e) {
        const code = (e as { code?: string }).code ?? 'internal';
        port.send(errRes(req.id, code, (e as Error).message ?? String(e)));
      }
    });
    port.onClose(() => {
      ports.delete(port);
      clients.delete(port);
      // a session whose owner is gone is up for grabs again: the next client
      // to report a size (or type) claims it and reflows to its own screen
      for (const [sid, p] of controller) if (p === port) controller.delete(sid);
    });
  }

  return {
    attach,
    broadcast,
    shutdown: () => {
      meta.stop();
      taskWatcher?.close();
      chatWatcher?.close();
      if (discoveryTimer) clearInterval(discoveryTimer);
      void lan?.shutdown();
      relay?.shutdown();
      sync?.shutdown();
      deps.externalAccess?.off('changed', accessChanged);
      sessions.shutdown();
    },
  };
}
