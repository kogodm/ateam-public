import type { BgShellDTO, ExternalRunDTO, ProviderId, SubagentDTO } from '@ateam/contract';
import { asciiPunctuation, asciiPunctuationAt } from '@ateam/contract';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalRunCard, useExternalRuns } from './ExternalRunFeed';
import { FoxWait } from './FoxWait';
import { HistoricalToolCard } from './HistoricalToolCard';
import { InjectedUserTurnCard, confirmsOptimisticUserTurn } from './InjectedUserTurn';
import { PathContextMenu, usePathMenu } from './PathContextMenu';
import { StreamModelPicker } from './StreamModelPicker';
import { atTokenAt, insertMention, useAtMatches } from './atMention';
import {
  atAtTokenAt,
  insertHumanMention,
  matchHumanMentions,
  type HumanMentionCandidate,
} from './humanMention';
import { AVATAR_IDS, avatarSrc } from './avatars';
import { codePath, codeUrl, markCodePaths } from './codePath';
import { codexToolLabel } from './codexToolLabel';
import { insertExternalRuns, lastConversationItemIndex } from './externalRunTimeline';
import {
  ATTACHED_PREFIX,
  UPLOAD_PATH_RE,
  composePayload,
  messageBody,
  sameMessage,
} from './composePayload';
import { registerComposer, unregisterComposer } from './composerRegistry';
import { resolveDocLink } from './docLink';
import { FOX_LINES } from './foxLines';
import { projectHistoricalTools } from './historicalTools';
import { imageObjectUrl } from './imageBlob';
import { findImagePaths } from './imagePaths';
import {
  isViewedImageTool,
  viewedImageBasename,
  viewedImagePath,
} from './viewedImage';
import { useImeGuard } from './imeGuard';
import { marked } from './markdown';
import { isModelPicker } from './modelPickerActions';
import {
  cacheModelMenu,
  cleanModelLabel,
  type ModelOption,
  type PendingModel,
} from './modelMenuCache';
import { applyModelSwitch } from './modelSwitch';
import { PASTE_MAX_BYTES, fileBase64, imageFilesFrom, pastedName } from './pasteImages';
import { PATH_DRAG_MIME, formatPathForInput } from './pathInsert';
import { plainLine } from './plainLine';
import { splitQueue } from './queueTray';
import { cleanAnswer, splitAnswers } from './askAnswers';
import type { Rpc } from './rpc';
import {
  type QueuePending,
  confirmedScreenPending,
  expireQueuePending,
  rememberScreenQueued,
  screenQueue,
  screenQueuedIds,
} from './screenQueue';
import { type SlashSuggestion, matchSlashCommands, slashKeyAction } from './slashPalette';
import { splitAtPictures } from './splitAtPictures';
import { loadDraft, saveDraft } from './streamDrafts';
import {
  LOCAL_COMMAND_DONE,
  reviewSubmitIsHighlighted,
  screenAwaitsSubmit,
  COMPACTING_RE,
  screenBusyStatusLine,
  screenIsBusy,
  shouldPulse,
} from './streamPulse';
import { pictureRun, swipeAxis, swipeFollow, swipePage } from './swipePage';
import { hasAnswerForQuestion } from './questionSelection';
import { readScreen } from './termRegistry';
import { type Run, canGroupTool, groupToolRuns, isRun } from './toolRuns';
import {
  type TuiPicker,
  freeTextOption,
  isSpaceToggleMulti,
  keysToNext,
  keysToReach,
  parsePicker,
  typedIn,
} from './tuiPicker';
import { keyOf } from './turnKey';
import { type Box, useContentBox, zoomedSize } from './zoomBox';

/* line-stroke icons, currentColor — the app's icon style, never emoji */
const svg = (paths: JSX.Element, size = 16): JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {paths}
  </svg>
);

const IconSend = svg(<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />, 18);
const IconPlus = svg(<path d="M12 5v14M5 12h14" />, 20);
const IconDown = svg(<path d="M12 5v14M5.5 12.5 12 19l6.5-6.5" />, 14);
const IconStop = (
  // ~1/3 of the 36px circle — a smaller square reads as a stray dot
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
    <rect x="5.5" y="5.5" width="13" height="13" rx="3" />
  </svg>
);
const IconImage = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 18 5-5 3 3 4-4 4 4" />
  </>,
  13,
);
const IconTool = svg(
  <path d="M14.5 6.5a4 4 0 0 0 5 5l-8 8a2.1 2.1 0 0 1-3-3l8-8a4 4 0 0 0-2-2 4 4 0 0 0-5 5" />,
  12,
);
/** a plain outline bulb in the fox's stroke family (1.8, round caps) */
const IconThink = svg(
  <>
    <path d="M9 16.5a6 6 0 1 1 6 0V18H9Z" />
    <path d="M10 21h4" />
  </>,
  14,
);

/** The picture a tool card is ABOUT — a Read of a screenshot, an MCP tool
 *  handed an image path, or Codex ImageView / view_image (incl. file://).
 *  A shell that merely mentions a .png is still a command, not a picture. */
function imageArg(text: string, cwd?: string, toolName?: string, label?: string): string | null {
  if (isViewedImageTool(toolName, label)) return viewedImagePath(text, cwd, toolName);
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  return findImagePaths(t, cwd)[0] ?? null;
}

/** tools whose result says nothing the diff does not already say */
const WRITES_FILES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

interface Turn {
  seq: number;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  at: string;
  kind?: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  toolName?: string;
  label?: string;
  /** tool_result of an Edit/Write, or of a bash command that edited files:
   *  what it changed, one entry per file */
  patch?: readonly {
    readonly file: string;
    readonly hunks: readonly {
      readonly oldStart: number;
      readonly newStart: number;
      readonly lines: readonly string[];
    }[];
    /** lines the cap left out */
    readonly dropped?: number;
  }[];
  /** pairs a tool_result with its tool_use — see buildItems */
  toolUseId?: string;
  historical?: boolean;
  tokens?: number;
  queued?: boolean;
  dequeued?: boolean;
  injected?: 'handoff' | 'mid_turn' | 'compaction';
  /** the harness injected this "user" record — not the person's words */
  meta?: boolean;
  notice?: 'error' | 'info';
}

/**
 * Stream view: the SAME conversation as the terminal, rendered from the
 * structured transcript instead of PTY bytes. Coexists with the terminal —
 * a per-session toggle in the top bar flips between them.
 *
 * Why it exists: terminal output is rasterized at whatever width it was
 * printed at, and claude re-prints scrollback on every resize, stranding
 * narrow debris (see resizeGate). This view has no columns at all — text
 * reflows like a web page, so phones and pane-drags cost nothing.
 *
 * Granularity: one bubble per transcript record (claude writes whole
 * messages, not tokens), live-appended via `session.turn`. History comes
 * from `session.transcript` (tail-capped server side).
 */
export function StreamView({
  rpc,
  sessionId,
  active,
  cwd,
  pendingHandoff,
  humanName,
  model,
  providerId,
  onUserInput,
  onOpenPath,
  avatarOfSession,
  peerMentions,
}: {
  rpc: Rpc;
  sessionId: string;
  active: boolean;
  /** the model this conversation is on, as the runtime records it
   *  ("claude-fable-5-1"); absent until the session has answered once */
  model?: string;
  providerId?: ProviderId;
  /** session cwd — what a RELATIVE image path in an answer is relative to */
  cwd?: string;
  /** Handoff in flight. The terminal has covered itself for this since the
   *  feature shipped; the stream did not, so on a phone — where the stream IS
   *  the session — you could keep typing into a conversation that was being
   *  handed over, and watch output that was about to be replaced. */
  pendingHandoff?: boolean;
  /** the teammate this session is — named in the handoff overlay */
  humanName?: string;
  onUserInput?: (sessionId: string) => void;
  /** open a file or folder in the app (the terminal's link handler) */
  onOpenPath?: (path: string, cwd?: string, line?: number) => void;
  /** the avatar of whoever runs a session of this name — for messages another
   *  session sends here; absent when the name matches no session we know */
  avatarOfSession?: (name: string) => string | undefined;
  /** `@@` menu: same-project peers + directory-less Chats (names shown;
   *  inserted text carries `ateam:<sessionId>`) */
  peerMentions?: readonly HumanMentionCandidate[];
}): JSX.Element {
  const externalRuns = useExternalRuns(rpc, sessionId);
  const [turns, setTurns] = useState<Turn[]>([]);
  /* Drilled into a sub-agent: null = looking at the session itself.
     A sub-agent's conversation is a file the harness writes as it works, not
     a stream we are subscribed to, so this view polls while it is open and
     stops the moment you leave. */
  const [subagent, setSubagent] = useState<{ agentId: string; task: string } | null>(null);
  const [subTurns, setSubTurns] = useState<Turn[]>([]);
  const displayTurns = useMemo(() => projectHistoricalTools(turns), [turns]);
  const displaySubTurns = useMemo(() => projectHistoricalTools(subTurns), [subTurns]);
  const [subNote, setSubNote] = useState('');
  const [subText, setSubText] = useState('');
  /** agentIds this session has on disk — an Agent card is only a door when
      its agent is one of them. */
  const [knownAgents, setKnownAgents] = useState<Set<string>>(() => new Set());
  const [agentList, setAgentList] = useState<SubagentDTO[]>([]);
  /* A command left running in the background. Same overlay as a sub-agent —
     it is the same question ("what is that thing doing?") with a different
     answer shape: an agent has a conversation, a shell has output that grows
     until it stops. */
  const [bgShell, setBgShell] = useState<{ id: string; head: string } | null>(null);
  const [bgOut, setBgOut] = useState<{
    text: string;
    done: boolean;
    exitCode?: number;
    truncated: boolean;
    bytes: number;
    command?: string;
    label?: string;
    files?: { path: string; bytes: number; mtimeMs: number }[];
  } | null>(null);
  const [knownShells, setKnownShells] = useState<Map<string, BgShellDTO>>(() => new Map());
  const [loading, setLoading] = useState(true);
  // older-history paging: the first load parses only the tail of the file
  const [fromByte, setFromByte] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** transient "已加载 N 条" note — the anchor restore keeps the screen
   *  looking identical, so without it a successful load is invisible */
  const [olderNote, setOlderNote] = useState('');
  // messages we have sent but not yet seen come back in the transcript —
  // shown immediately with a pulse so the composer never feels laggy
  const [pending, setPending] = useState<QueuePending[]>([]);
  const pendingIdRef = useRef(0);
  /** how many of the person's own records the transcript has delivered. A
   *  pending bubble whose safety timer fires compares this against what it
   *  saw at send: if nothing of theirs has landed since, the message never
   *  made it and the bubble must NOT be dropped — that is a message the
   *  person watched disappear (09-22). */
  const userTurnsRef = useRef(0);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  /** pictures we sent, by message body: the record claude writes keeps only an
   *  `[Image #N]` placeholder, so the thumbnails ride over from the optimistic
   *  bubble when it retires (this client only; a reload shows the placeholder) */
  const carriedImages = useRef(new Map<string, string[]>());
  // an unsent message survives switching sessions — see streamDrafts.ts
  const [draft, setDraft] = useState(() => asciiPunctuation(loadDraft(sessionId).text));
  /* Let the rest of the app put text in this box — sending a task to a
     session must land where the user can actually see and edit it, and in
     stream mode that is here, not the hidden terminal. */
  useEffect(() => {
    if (!sessionId) return;
    registerComposer(
      sessionId,
      (text) => {
        const incoming = asciiPunctuation(text);
        setDraft((prev) =>
          prev.trim() ? `${prev.replace(/\s*$/, '')}\n${incoming}` : incoming,
        );
      },
      (paths) => dropPathsRef.current(paths),
    );
    return () => unregisterComposer(sessionId);
  }, [sessionId]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // dedupe between the history fetch and live events: the two seq spaces
  // are unrelated (history counts file lines, events count from the watch
  // offset), so identity is content-based.
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    seenRef.current = new Set();
    setTurns([]);
    setLoading(true);
    let dead = false;
    void rpc
      .request('session.transcript', { sessionId })
      .then((r) => {
        if (dead) return;
        const list = (r.turns as Turn[]).filter((t) => t.role !== 'system');
        for (const t of list) seenRef.current.add(keyOf(t));
        setTurns(list);
        setFromByte(r.fromByte ?? 0);
        setHasMore(Boolean(r.hasMore));
      })
      .catch(() => {})
      .finally(() => {
        if (!dead) setLoading(false);
      });
    const off = rpc.on('session.turn', (d) => {
      if (d.sessionId !== sessionId) return;
      const t = d.turn as Turn;
      if (t.role === 'system') return;
      const k = keyOf(t);
      if (seenRef.current.has(k)) return;
      seenRef.current.add(k);
      setTurns((prev) => [...prev, t]);
      // the real record landed — retire its optimistic twin
      if (confirmsOptimisticUserTurn(t)) {
        userTurnsRef.current += 1;
        const body = messageBody(t.text);
        const confirmed =
          providerId === 'codex' && !t.meta
            ? confirmedScreenPending(pendingRef.current, t.text, sameMessage)
            : undefined;
        const candidates =
          providerId === 'codex' ? (confirmed ? [confirmed] : []) : pendingRef.current;
        for (const m of candidates) {
          const pics = m.text.match(UPLOAD_PATH_RE);
          if (pics && sameMessage(m.text, t.text)) carriedImages.current.set(body, [...pics]);
        }
        setPending((prev) => {
          if (providerId !== 'codex') return prev.filter((m) => !sameMessage(m.text, t.text));
          if (t.meta) return prev;
          const matched = confirmedScreenPending(prev, t.text, sameMessage);
          return matched ? prev.filter((m) => m.id !== matched.id) : prev;
        });
      }
    });
    return () => {
      dead = true;
      off();
    };
  }, [rpc, sessionId, providerId]);

  // tail-follow: stick to the bottom unless the user scrolled up to read
  // an IME's commit-Enter must never send the half-typed message
  const ime = useImeGuard();
  const nearBottomRef = useRef(true);
  // Reading back through history must NOT be yanked to the bottom by new
  // output. While scrolled up we count what arrives and offer a pill; only
  // a tap (or already being at the bottom) scrolls.
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const loadingMoreRef = useRef(false);
  const loadOlder = useCallback(() => {
    if (loadingMoreRef.current || !hasMore || fromByte <= 0) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const el = scrollRef.current;
    const anchorFromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    const startedAt = Date.now();

    /** A window can be all system records or all already-seen turns, and a
     *  read takes ~4ms — so keep walking back until something is actually
     *  worth showing, instead of making the user scroll again for nothing. */
    const step = async (
      before: number,
      hops: number,
    ): Promise<{ older: Turn[]; fromByte: number; hasMore: boolean }> => {
      const r = await rpc.request('session.olderTranscript', {
        sessionId,
        beforeByte: before,
      });
      const older = (r.turns as Turn[]).filter(
        (t) => t.role !== 'system' && !seenRef.current.has(keyOf(t)),
      );
      if (older.length === 0 && r.hasMore && r.fromByte > 0 && r.fromByte < before && hops < 8) {
        return step(r.fromByte, hops + 1);
      }
      return { older, fromByte: r.fromByte, hasMore: r.hasMore };
    };

    void step(fromByte, 0)
      .then(({ older, fromByte: nextFrom, hasMore: more }) => {
        for (const t of older) seenRef.current.add(keyOf(t));
        setFromByte(nextFrom);
        setHasMore(more);
        if (older.length > 0) setTurns((prev) => [...older, ...prev]);
        setOlderNote(
          older.length > 0
            ? `Loaded ${older.length} older ${older.length === 1 ? 'message' : 'messages'}`
            : 'No older messages',
        );
        setTimeout(() => setOlderNote(''), 2500);
        // keep the reader's eyes where they were: content grew ABOVE them
        requestAnimationFrame(() => {
          const e2 = scrollRef.current;
          if (e2) e2.scrollTop = e2.scrollHeight - anchorFromBottom;
        });
      })
      .catch(() => {})
      .finally(() => {
        // a 4ms load flashes the spinner too fast to register as "loading"
        const rest = Math.max(0, 350 - (Date.now() - startedAt));
        setTimeout(() => {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }, rest);
      });
  }, [rpc, sessionId, fromByte, hasMore]);

  // Watching scrollTop is not enough: on iOS the elastic overscroll at the
  // top ("拖动出的空距离") keeps scrollTop pinned at 0 and fires no scroll
  // event at all, so the load never triggered and the user had to tap the
  // line. A sentinel at the head of the list does the right thing in every
  // case — including a conversation shorter than the viewport, where no
  // scrolling is possible.
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadingMore re-observes once a load settles
  useEffect(() => {
    const node = topSentinelRef.current;
    const root = scrollRef.current;
    if (!node || !root || !active || loading || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadOlder();
      },
      { root, rootMargin: '200px 0px 0px 0px' },
    );
    io.observe(node);
    return () => io.disconnect();
    // loadingMore too: a load that ends with the sentinel STILL in view fires no
    // new intersection, and the one that fired meanwhile was dropped by the
    // in-flight guard — re-observing when loading settles re-checks
  }, [active, loading, loadingMore, hasMore, loadOlder]);

  // A tail window can hold almost nothing: a transcript whose last 768KB is a
  // dozen screenshot results showed three cards and stopped (color, 09-17).
  // Until the list fills the screen, keep walking back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: turns.length — re-measure when the list grows
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active || loading || loadingMore || !hasMore) return;
    if (el.scrollHeight - el.clientHeight < 240) loadOlder();
  }, [active, loading, loadingMore, hasMore, loadOlder, turns.length]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    nearBottomRef.current = near;
    setAtBottom(near);
    if (near) setUnseen(0);
  }, []);
  /** Snap to the newest content and treat the view as pinned there. Used
   *  after sending: the message you just wrote must be on screen, whether or
   *  not you had scrolled up to read history. A frame is skipped first so the
   *  pending bubble is laid out and scrollHeight already includes it. */
  const stickToBottom = useCallback(() => {
    nearBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    nearBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
  }, []);
  const prevCountRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new turns / activation
  useEffect(() => {
    const el = scrollRef.current;
    const grew = turns.length - prevCountRef.current;
    prevCountRef.current = turns.length;
    if (!el) return;
    // entering the view (or the first load landing) starts at the bottom
    if (loading) return;
    if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (grew > 0) setUnseen((n) => n + grew);
    // pending.length too: the bubble for a message you just sent is not a
    // transcript turn, and it still has to bring the view down with it
  }, [turns.length, pending.length, active, loading]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || loading || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [externalRuns, loading]);
  // The soft keyboard eats half the screen: when it slides in, the newest
  // messages must stay in view instead of hiding behind it.
  useEffect(() => {
    if (!active) return;
    const vv = window.visualViewport;
    if (!vv) return;
    let prev = vv.height;
    const onResize = (): void => {
      const shrank = vv.height < prev - 80; // keyboard, not a toolbar nudge
      prev = vv.height;
      if (!shrank) return;
      const el = scrollRef.current;
      if (!el) return;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
        nearBottomRef.current = true;
        setAtBottom(true);
        setUnseen(0);
      });
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [active]);

  // switching INTO this session's stream: land at the bottom, fresh counters
  useEffect(() => {
    if (!active) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    nearBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
  }, [active]);
  // The list's box shrinks under it after it has already been scrolled down:
  // the background-task bar arrives with the first poll, the queue tray and
  // pickers come and go, the composer grows a line. None of that fires a
  // scroll, so the newest messages ended up hidden behind the bar. A view
  // pinned to the bottom stays pinned; one scrolled up to read is left alone.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* Links in rendered markdown are plain DOM. Unhandled, a click in the
     desktop window did nothing at all (and a relative href would navigate the
     webview away). Resolve each the way the document preview does: web links
     to a browser — the system one on the desktop, the phone's own on a phone —
     and files or folders into the app. */
  /** the system browser on the desktop; the phone's own browser on a phone */
  const openExternalUrl = (url: string): void => {
    if (inDesktopWindow()) void rpc.request('url.open', { url }).catch(() => {});
    else window.open(url, '_blank', 'noopener,noreferrer');
  };
  const onLinkClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    // a path claude wrote as inline code — see codePath.ts
    const code = (e.target as HTMLElement).closest('code.sv-path');
    if (code && e.currentTarget.contains(code)) {
      const url = codeUrl(code.textContent ?? '');
      if (url) {
        e.preventDefault();
        openExternalUrl(url);
        return;
      }
      const hit = codePath(code.textContent ?? '');
      if (hit) {
        e.preventDefault();
        onOpenPath?.(hit.path, cwd, hit.line);
      }
      return;
    }
    const a = (e.target as HTMLElement).closest('a');
    if (!a || !e.currentTarget.contains(a)) return;
    const href = a.getAttribute('href') ?? '';
    if (!href) return;
    const link = resolveDocLink(`${cwd || ''}/.`, href);
    if (link.kind === 'anchor' || link.kind === 'none') return;
    e.preventDefault();
    if (link.kind === 'external') {
      openExternalUrl(link.url);
      return;
    }
    onOpenPath?.(link.path, cwd);
  };

  /* Right-click a path in the conversation — inline code, a markdown link, a
     file in a diff — and get the same Open / Reveal in Finder / Copy Path
     menu the file panels have. Desktop only: on a phone a long press IS
     contextmenu, and eating it would take away selecting text (and there is
     no Finder on the other end anyway). */
  const { menu, openMenu, closeMenu } = usePathMenu();
  /** a relative path in the conversation means "under the session's cwd" —
   *  reveal needs it absolute, the sidecar's own cwd is not it */
  const absPath = (path: string): string =>
    path.startsWith('/') || path.startsWith('~')
      ? path
      : `${(cwd || '').replace(/\/+$/, '')}/${path}`;
  const pathUnder = (el: HTMLElement): string | null => {
    const code = el.closest('code.sv-path');
    // a code span can also be a URL — that one has nothing to reveal
    if (code) {
      const hit = codePath(code.textContent ?? '');
      return hit ? absPath(hit.path) : null;
    }
    const file = el.closest('.sv-diff-file');
    if (file) return file.textContent ? absPath(file.textContent) : null;
    const a = el.closest('a');
    if (a) {
      const link = resolveDocLink(`${cwd || ''}/.`, a.getAttribute('href') ?? '');
      if (link.kind === 'file' || link.kind === 'dir') return link.path;
    }
    return null;
  };
  const onPathMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = e.target as HTMLElement;
    const a = el.closest('a');
    const dir =
      !!a && resolveDocLink(`${cwd || ''}/.`, a.getAttribute('href') ?? '').kind === 'dir';
    const path = pathUnder(el);
    if (path) openMenu(e, path, dir);
  };

  const [sendErr, setSendErr] = useState('');
  // claude's OWN pickers (/model, permission prompts, menus) never reach the
  // transcript — they live in the TUI. Read them off the hidden terminal's
  // screen so a stream-mode user can answer without switching modes.
  const [picker, setPicker] = useState<TuiPicker | null>(null);
  const [quickModelOpen, setQuickModelOpen] = useState(false);
  const [pendingModel, setPendingModel] = useState<PendingModel | null>(null);
  const [switchingModel, setSwitchingModel] = useState(false);
  const switchingRef = useRef(false);
  const modelSwitchPromiseRef = useRef<Promise<void> | null>(null);
  const modelScope = useRef(0);
  const modelContext = useRef({ sessionId, providerId, active, pendingHandoff });
  modelContext.current = { sessionId, providerId, active, pendingHandoff };
  useEffect(() => {
    setPendingModel(null);
    setQuickModelOpen(false);
    modelSwitchPromiseRef.current = null;
    switchingRef.current = false;
    setSwitchingModel(false);
    return () => {
      modelScope.current++;
    };
  }, [sessionId, providerId]);
  /** the answers are in and claude's review screen wants one Enter */
  const [awaitingSubmit, setAwaitingSubmit] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewSubmitStatus, setReviewSubmitStatus] = useState('');
  const reviewSubmitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!awaitingSubmit) {
      if (reviewSubmitTimer.current) clearTimeout(reviewSubmitTimer.current);
      reviewSubmitTimer.current = null;
      setReviewSubmitting(false);
      setReviewSubmitStatus('');
    }
  }, [awaitingSubmit]);
  useEffect(
    () => () => {
      if (reviewSubmitTimer.current) clearTimeout(reviewSubmitTimer.current);
    },
    [sessionId],
  );
  /** the AskUserQuestion "Type something." row being answered from the stream */
  const [pickerText, setPickerText] = useState<string | null>(null);
  const textRow = picker ? freeTextOption(picker) : undefined;
  // a different question (or none): whatever was being typed belonged to the last
  const pickerTitle = picker?.title;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the question changes
  useEffect(() => setPickerText(null), [pickerTitle]);
  // the command's picker is its answer — the sent-command bubble is done
  useEffect(() => {
    if (picker) setPending((prev) => prev.filter((m) => !m.text.startsWith('/')));
  }, [picker]);
  /** Consecutive polls in which claude's TUI did NOT offer "esc to interrupt".
   *  The footer carries that hint exactly while there is something to
   *  interrupt, so a run of them is the terminal saying the turn is over —
   *  which the transcript alone cannot tell us (see `working`). */
  const [ptyIdleTicks, setPtyIdleTicks] = useState(0);
  const [ptyBusy, setPtyBusy] = useState<boolean | null>(null);
  const [codexQueue, setCodexQueue] = useState<string[]>([]);
  const codexQueueRef = useRef<readonly string[]>([]);
  /** Screen-only busy status: Compacting conversation…, or API retry wait. */
  const [busyStatusLine, setBusyStatusLine] = useState<string | null>(null);
  /** Trust the ABSENCE of the hint only after we have seen it at least once:
   *  an older claude that never prints it must not be read as permanently
   *  idle, and neither must a screen we cannot read yet. */
  const sawBusyHintRef = useRef(false);
  useEffect(() => {
    codexQueueRef.current = [];
    setCodexQueue([]);
    if (!active) {
      setPicker(null);
      setPtyBusy(null);
      return;
    }
    sawBusyHintRef.current = false;
    setPtyIdleTicks(0);
    setPtyBusy(null);
    const tick = (): void => {
      const rows = readScreen(sessionId);
      const queue = screenQueue(rows, providerId);
      codexQueueRef.current = queue;
      setCodexQueue(queue);
      if (providerId === 'codex') setPending((prev) => rememberScreenQueued(prev, queue));
      const currentPicker = parsePicker(rows);
      cacheModelMenu(providerId ?? 'claude', currentPicker);
      setPicker(currentPicker);
      setAwaitingSubmit(screenAwaitsSubmit(rows));
      setBusyStatusLine(screenBusyStatusLine(rows));
      const busy = screenIsBusy(rows);
      setPtyBusy(busy);
      if (busy === null) return; // no terminal mounted — no opinion to give
      if (busy) sawBusyHintRef.current = true;
      setPtyIdleTicks((n) => (busy ? 0 : n + 1));
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [active, sessionId, providerId]);
  // picked photos live HERE as thumbnail cards in the pill (the reference
  // UX), never as raw paths polluting the text field
  const [attachments, setAttachments] = useState<
    { path: string; url: string; uploading?: boolean }[]
  >(() => loadDraft(sessionId).attachments);
  useEffect(() => {
    saveDraft(sessionId, {
      text: draft,
      attachments: attachments.filter((a) => !a.uploading).map(({ path, url }) => ({ path, url })),
    });
  }, [sessionId, draft, attachments]);
  /** tapped image → full-screen viewer (pinch-zoomable). It holds the whole
   *  run of pictures the stream is showing, in document order, not just the
   *  one that was tapped: at fit size a flick pages through them, which is
   *  what a phone user expects of anything full-screen. The run is read off
   *  the DOM when the viewer opens — every thumb is mounted by then and its
   *  blob src is exactly what the viewer needs — so nothing has to be
   *  registered, ordered, or re-fetched. */
  const [viewer, setViewer] = useState<{
    items: { src: string; name: string; full?: string }[];
    i: number;
  } | null>(null);
  const shown = viewer ? (viewer.items[viewer.i] ?? null) : null;
  const openViewer = useCallback((v: { src: string; name: string }) => {
    const root = scrollRef.current;
    const items = root
      ? [...root.querySelectorAll<HTMLImageElement>('img.sv-img-thumb')].map((n) => ({
          src: n.src,
          name: n.alt,
          ...(n.dataset.full ? { full: n.dataset.full } : {}),
        }))
      : [];
    setViewer(pictureRun(items, v));
  }, []);
  /* Zoom inside the viewer, by hand.
     The obvious route — touch-action:pinch-zoom and let the browser do it —
     cannot work here: index.html asks for user-scalable=no (so the app is not
     zoomable by stray gestures, and so iOS does not jump the page when an
     input takes focus), and a home-screen PWA honours that. The page will
     never pinch, whatever a child element asks for. So the gesture is ours:
     two pointers scale about their midpoint, one pointer pans once zoomed,
     double-tap toggles. Pointer events cover touch and mouse alike. */
  const [zoom, setZoom] = useState({ k: 1, x: 0, y: 0 });
  // zoom is laid out as a real size (see zoomBox.ts — scale() blurs on WebKit),
  // which needs the picture's natural size and the stage's box
  const [viewerNatural, setViewerNatural] = useState<Box | null>(null);
  const viewerStageRef = useRef<HTMLDivElement>(null);
  const viewerStage = useContentBox(viewerStageRef, !!viewer);
  const viewerBox =
    viewerNatural && viewerStage ? zoomedSize(viewerNatural, viewerStage, zoom.k) : null;
  /* Inline pictures are scaled copies (file.thumb). Opened, the original is
     fetched in the background; the copy stands in until it lands. */
  const [fullSrc, setFullSrc] = useState<Record<string, string>>({});
  const shownFull = shown?.full;
  useEffect(() => {
    if (!shownFull || fullOriginals.has(shownFull)) return;
    let alive = true;
    // an original over file.read's size cap comes back "unsupported": then a
    // full-size JPEG of it instead (an 18MB contact sheet stayed a blur)
    void rpc
      .request('file.read', { path: shownFull })
      .then((r) =>
        r.kind === 'image' && r.base64
          ? r
          : rpc.request('file.thumb', { path: shownFull, max: FULL_EDGE }),
      )
      .then((r) => {
        if (r.kind !== 'image' || !r.base64) return;
        const url = imageObjectUrl(r.base64, r.mime);
        rememberOriginal(shownFull, url);
        if (alive) setFullSrc((m) => ({ ...m, [shownFull]: url }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [rpc, shownFull]);
  const shownSrc = shown
    ? (shown.full && (fullSrc[shown.full] ?? fullOriginals.get(shown.full))) || shown.src
    : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new picture must not inherit the last one's size
  useEffect(() => setViewerNatural(null), [shownSrc]);
  /* Paging by flick. Whether a one-finger drag pages or pans depends on the
     zoom — a fit-size picture has nowhere to pan to — and, once the finger has
     moved a few pixels, on the axis it chose. Deciding the axis ONCE and
     sticking to it is what keeps a slightly diagonal swipe from wobbling
     between paging and doing nothing. */
  const swipeRef = useRef<{ x: number; y: number; axis: 'undecided' | 'x' | 'y' } | null>(null);
  const [swipe, setSwipe] = useState<{ dx: number; animating: boolean }>({
    dx: 0,
    animating: false,
  });
  const swipeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** the swap the picture on its way out is headed for — kept so a finger
   *  landing mid-flight can finish it NOW instead of cancelling it and leaving
   *  a picture parked off-screen */
  const pendingGo = useRef<(() => void) | null>(null);
  const flushSwipe = useCallback(() => {
    if (swipeTimer.current) clearTimeout(swipeTimer.current);
    swipeTimer.current = null;
    const f = pendingGo.current;
    pendingGo.current = null;
    f?.();
  }, []);
  const canGo = useCallback(
    (dir: number) => !!viewer && viewer.i + dir >= 0 && viewer.i + dir < viewer.items.length,
    [viewer],
  );
  const go = useCallback((dir: number) => {
    setSwipe({ dx: 0, animating: false });
    setViewer((v) => (v?.items[v.i + dir] ? { ...v, i: v.i + dir } : v));
  }, []);
  /** Finger lifted after an x-drag: either carry the picture off the way it
   *  was going and swap, or let it spring back. */
  const endSwipe = useCallback(
    (dx: number) => {
      const w = viewerStageRef.current?.clientWidth ?? 320;
      const dir = swipePage(dx, w, canGo(-1), canGo(1));
      if (!dir) {
        setSwipe({ dx: 0, animating: true });
        return;
      }
      setSwipe({ dx: -dir * w, animating: true });
      pendingGo.current = () => go(dir);
      swipeTimer.current = setTimeout(() => {
        swipeTimer.current = null;
        pendingGo.current = null;
        go(dir);
      }, 170);
    },
    [canGo, go],
  );
  useEffect(
    () => () => {
      if (swipeTimer.current) clearTimeout(swipeTimer.current);
    },
    [],
  );
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; k: number } | null>(null);
  const ZOOM_MAX = 12;
  // below 1 the picture is smaller than the stage — the file preview allows
  // it, so the viewer does too rather than refusing to zoom out
  const ZOOM_MIN = 0.15;
  // biome-ignore lint/correctness/useExhaustiveDependencies: every picture — the first and each one paged to — opens at fit-to-screen, never inheriting the last one's zoom
  useEffect(() => {
    setZoom({ k: 1, x: 0, y: 0 });
    ptrs.current.clear();
    pinchRef.current = null;
  }, [shownSrc]);
  const zoomReset = useCallback(() => {
    setZoom({ k: 1, x: 0, y: 0 });
    setSwipe({ dx: 0, animating: false });
    ptrs.current.clear();
    pinchRef.current = null;
    swipeRef.current = null;
  }, []);
  const onZoomDown = useCallback(
    (e: React.PointerEvent) => {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // catching a picture mid-flight lands it on the one it was going to —
      // cancelling instead would leave the old picture parked off-screen
      if (swipeTimer.current) flushSwipe();
      if (ptrs.current.size === 1 && e.pointerType !== 'mouse') {
        swipeRef.current = { x: e.clientX, y: e.clientY, axis: 'undecided' };
        setSwipe({ dx: 0, animating: false });
      }
      if (ptrs.current.size === 2) {
        // a second finger means pinch, never page
        swipeRef.current = null;
        setSwipe({ dx: 0, animating: true });
        const [a, b] = [...ptrs.current.values()];
        if (a && b) pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: zoom.k };
      }
    },
    [zoom.k, flushSwipe],
  );
  const onZoomMove = useCallback(
    (e: React.PointerEvent) => {
      if (!ptrs.current.has(e.pointerId)) return;
      const prev = ptrs.current.get(e.pointerId);
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.current.size >= 2) {
        const [a, b] = [...ptrs.current.values()];
        const start = pinchRef.current;
        if (!a || !b || !start) return;
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (start.k * dist) / start.dist));
        setZoom((z) => (k === 1 ? { k: 1, x: 0, y: 0 } : { ...z, k }));
        return;
      }
      // At fit size the finger pages instead: the picture follows it, and
      // where there is nothing to page to it gives a little and comes back,
      // which says "that's the end" without a word.
      const sw = swipeRef.current;
      if (sw && zoom.k <= 1) {
        const dx = e.clientX - sw.x;
        const dy = e.clientY - sw.y;
        if (sw.axis === 'undecided') {
          const axis = swipeAxis(dx, dy);
          if (!axis) return;
          sw.axis = axis;
        }
        if (sw.axis === 'x') {
          setSwipe({ dx: swipeFollow(dx, canGo(-1), canGo(1)), animating: false });
          return;
        }
      }
      if (!prev) return;
      // A finger may only pan once zoomed in — at fit size a swipe pages (see
      // above). A mouse has no such ambiguity: it drags at any zoom, which is
      // what the file preview does.
      const dragAlways = e.pointerType === 'mouse';
      setZoom((z) =>
        !dragAlways && z.k <= 1
          ? z
          : { ...z, x: z.x + (e.clientX - prev.x), y: z.y + (e.clientY - prev.y) },
      );
    },
    [zoom.k, canGo],
  );
  const onZoomUp = useCallback(
    (e: React.PointerEvent) => {
      ptrs.current.delete(e.pointerId);
      if (ptrs.current.size < 2) pinchRef.current = null;
      const sw = swipeRef.current;
      swipeRef.current = null;
      if (sw?.axis === 'x') endSwipe(swipe.dx);
    },
    [endSwipe, swipe.dx],
  );
  /* Mouse wheel zooms about the cursor, the same gesture (and the same focal
     -point maths) the file preview uses: the image sits centred plus a pan
     offset, so to hold the point under the cursor still while scaling by f
     the new offset is d·(1−f) + f·offset, d being the cursor's distance from
     the stage centre. Bound natively because React's onWheel is passive and
     cannot preventDefault — without that the whole stream scrolls instead. */
  useEffect(() => {
    const el = viewerStageRef.current;
    if (!el || !viewer) return;
    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const dx = ev.clientX - (r.left + r.width / 2);
      const dy = ev.clientY - (r.top + r.height / 2);
      setZoom((z) => {
        const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z.k * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
        if (k === z.k) return z;
        const f = k / z.k;
        return { k, x: dx * (1 - f) + f * z.x, y: dy * (1 - f) + f * z.y };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewer]);
  /* The same paging from a keyboard — a desktop mouse drags at every zoom
     (see onZoomMove), so it has no flick to page with. Bound on the window
     because the overlay is a div nothing ever focuses. */
  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Escape') {
        zoomReset();
        setViewer(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, go, zoomReset]);

  const [slashCmds, setSlashCmds] = useState<{
    sessionId: string;
    providerId?: ProviderId;
    rpc: Rpc;
    commands: SlashSuggestion[];
  } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashToken = /^\/(\S*)$/.exec(draft.trimStart());
  const slashOpen = slashToken !== null && !slashDismissed;
  const slashLoaded =
    slashCmds?.sessionId === sessionId &&
    slashCmds.providerId === providerId &&
    slashCmds.rpc === rpc;
  useEffect(() => {
    if (!slashOpen || slashLoaded) return;
    let alive = true;
    void rpc
      .request('claude.commands', { sessionId })
      .then((response) => {
        if (alive) setSlashCmds({ sessionId, providerId, rpc, commands: response.commands });
      })
      .catch(() => {
        if (alive) setSlashCmds({ sessionId, providerId, rpc, commands: [] });
      });
    return () => {
      alive = false;
    };
  }, [slashOpen, slashLoaded, rpc, sessionId, providerId]);
  const slashMatches =
    slashOpen && slashLoaded && slashCmds ? matchSlashCommands(slashCmds.commands, draft) : [];
  const selectedSlash = Math.min(slashIndex, Math.max(0, slashMatches.length - 1));
  useEffect(() => {
    if (slashOpen && slashMatches.length > 0) {
      slashMenuRef.current
        ?.querySelector(`[data-slash-index="${selectedSlash}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedSlash, slashOpen, slashMatches.length]);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // `@` file mentions, as in the CLI: a menu of matching paths under the
  // session cwd while an `@…` is being typed at the caret
  const [caret, setCaret] = useState(0);
  const [atIndex, setAtIndex] = useState(0);
  /** the `@` whose menu Esc closed — it stays closed until another `@` */
  const [atDismissed, setAtDismissed] = useState<number | null>(null);
  // `@@` human/session mentions — same-project or Chats; menu shows name
  const [atAtIndex, setAtAtIndex] = useState(0);
  const [atAtDismissed, setAtAtDismissed] = useState<number | null>(null);
  const atAtTok = atAtTokenAt(draft, caret);
  const atAtQuery = atAtTok && atAtTok.start !== atAtDismissed ? atAtTok.query : null;
  const atAtHits = useMemo(
    () => (atAtQuery === null ? [] : matchHumanMentions(peerMentions ?? [], atAtQuery)),
    [peerMentions, atAtQuery],
  );
  const atAtOpen = atAtQuery !== null;
  const atTok = atAtOpen ? null : atTokenAt(draft, caret);
  const atQuery = atTok && atTok.start !== atDismissed ? atTok.query : null;
  const atHits = useAtMatches(rpc, cwd, atQuery);
  const atOpen = atQuery !== null && atHits.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new query
  useEffect(() => setAtIndex(0), [atQuery]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new query
  useEffect(() => setAtAtIndex(0), [atAtQuery]);
  const pickMention = (path: string): void => {
    if (!atTok) return;
    const r = insertMention(draft, caret, atTok, path);
    setDraft(r.text);
    setCaret(r.caret);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(r.caret, r.caret);
    });
  };
  const pickHumanMention = (hit: { name: string; sessionId: string }): void => {
    if (!atAtTok) return;
    const r = insertHumanMention(draft, caret, atAtTok, hit);
    setDraft(r.text);
    setCaret(r.caret);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(r.caret, r.caret);
    });
  };
  // a restored draft gets the height typing would have given it
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    const el = taRef.current;
    if (!el || !el.value) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  /** raw control sequences (Esc / arrows / ^C…) still go straight to the
   *  PTY — the TUI behind this view is what reacts to them */
  const sendSeq = useCallback(
    (seq: string) => {
      if (pendingHandoff || switchingRef.current) return; // the successor or switch owns the input now
      onUserInput?.(sessionId);
      void rpc.request('session.input', { sessionId, data: seq }).catch((e: unknown) => {
        setSendErr(`Send failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    },
    [rpc, sessionId, onUserInput, pendingHandoff],
  );
  const submitReviewAnswers = useCallback(() => {
    const rows = readScreen(sessionId);
    if (!screenAwaitsSubmit(rows)) {
      setAwaitingSubmit(false);
      setReviewSubmitStatus('');
      const message = 'Review screen changed. Check the current prompt in Terminal.';
      setSendErr(message);
      window.setTimeout(() => setSendErr((current) => (current === message ? '' : current)), 2000);
      return;
    }
    if (!reviewSubmitIsHighlighted(rows)) {
      setReviewSubmitStatus('Select Submit in Terminal before submitting.');
      return;
    }
    if (reviewSubmitTimer.current) clearTimeout(reviewSubmitTimer.current);
    setReviewSubmitting(true);
    setReviewSubmitStatus('');
    sendSeq('\r');
    reviewSubmitTimer.current = setTimeout(() => {
      reviewSubmitTimer.current = null;
      setReviewSubmitting(false);
      const currentRows = readScreen(sessionId);
      if (screenAwaitsSubmit(currentRows)) {
        setReviewSubmitStatus('Still waiting—try again or use Terminal');
      } else {
        setAwaitingSubmit(false);
        setReviewSubmitStatus('');
      }
    }, 2000);
  }, [sendSeq, sessionId]);
  /** photo → sidecar upload → the PATH lands in the VISIBLE composer, not
   *  in the invisible terminal input box (the terminal-mode attach types it
   *  into the PTY, which in stream mode the user cannot see or verify) */
  /** One picture → a thumbnail card in the pill, uploaded behind it. The
   *  photo picker and a paste both come through here, so a pasted screenshot
   *  looks, uploads and sends exactly like a picked photo. */
  /* Files dropped on the window (Finder, or the Files panel). A picture is
     already on disk, so it needs no upload — it joins the pill as a card, read
     for display through file.thumb. Anything else goes in as its path, the
     way the terminal takes a drop. */
  const dropPaths = useCallback(
    (paths: string[]) => {
      const pics = paths.filter((p) => DROP_IMAGE_RE.test(p));
      const rest = paths.filter((p) => !DROP_IMAGE_RE.test(p));
      if (pics.length)
        setAttachments((a) => [...a, ...pics.map((path) => ({ path, url: '', uploading: false }))]);
      if (rest.length)
        setDraft((prev) => {
          const add = rest.map(formatPathForInput).join('').trim();
          return prev.trim() ? `${prev.replace(/\s*$/, '')} ${add}` : add;
        });
      stickToBottom();
    },
    [stickToBottom],
  );
  // a dropped picture has no local blob: read a small copy so the pill shows
  // the photo rather than a file name
  useEffect(() => {
    const missing = attachments.filter((a) => !a.url && !a.uploading).map((a) => a.path);
    if (missing.length === 0) return;
    let alive = true;
    for (const path of missing) {
      void rpc
        .request('file.thumb', { path, max: 240 })
        .then((r) => {
          if (!alive || r.kind !== 'image' || !r.base64) return;
          const url = `data:${r.mime};base64,${r.base64}`;
          setAttachments((a) => a.map((x) => (x.path === path ? { ...x, url } : x)));
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [rpc, attachments]);
  const dropPathsRef = useRef(dropPaths);
  dropPathsRef.current = dropPaths;
  /** a DOM drag (the Files panel) or an OS drop landing on the stream itself */
  const onDropFiles = (e: React.DragEvent): void => {
    if (pendingHandoff) return;
    const path = e.dataTransfer.getData(PATH_DRAG_MIME) || e.dataTransfer.getData('text/plain');
    if (!path) return; // an OS file drop reaches us through Tauri, not the DOM
    e.preventDefault();
    dropPaths([path]);
  };

  const attachFile = useCallback(
    async (f: File, name: string = f.name) => {
      if (f.size > PASTE_MAX_BYTES) {
        setSendErr('Attachment too large (15MB max)');
        return;
      }
      setSendErr('');
      // show the picked photo AT ONCE (it is already on this device) with a
      // spinner over it — waiting for the upload to draw anything made the
      // attach feel broken on a slow link
      const localUrl = URL.createObjectURL(f);
      const tempPath = `local:${localUrl}`;
      setAttachments((a) => [...a, { path: tempPath, url: localUrl, uploading: true }]);
      try {
        const up = await rpc.request('file.upload', { name, base64: await fileBase64(f) });
        rememberLocalThumb(up.path, f);
        setAttachments((a) =>
          a.map((x) =>
            x.path === tempPath ? { path: up.path, url: localUrl, uploading: false } : x,
          ),
        );
      } catch (err) {
        setAttachments((a) => a.filter((x) => x.path !== tempPath));
        setSendErr(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [rpc],
  );
  const onFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (f) void attachFile(f);
    },
    [attachFile],
  );
  /* A screenshot pasted into the box. Remotely this is the only way it can
     arrive — the picture is on the clipboard of the device in front of the
     user, not the Mac's (see pasteImages.ts). Text pastes are left to the
     textarea. */
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const images = imageFilesFrom(e.clipboardData);
      if (images.length === 0) return;
      e.preventDefault();
      for (const f of images) void attachFile(f, pastedName(f));
    },
    [attachFile],
  );
  const chooseModel = useCallback(
    (option: ModelOption | null) => {
      if (!option || !active || pendingHandoff || switchingRef.current) return;
      const displayedLabel = pendingModel?.label ?? (model ? modelShortName(model) : 'Select model');
      if (
        cleanModelLabel(option.label).toLowerCase() ===
        cleanModelLabel(displayedLabel).toLowerCase()
      )
        return;

      const previous = pendingModel;
      const target = { ...option, provider: providerId ?? 'claude' };
      setPendingModel(target);
      switchingRef.current = true;
      setSwitchingModel(true);
      setSendErr('');
      const scope = modelScope.current;
      const canSwitch = () => {
        const current = modelContext.current;
        return (
          scope === modelScope.current &&
          current.sessionId === sessionId &&
          current.providerId === providerId &&
          current.active &&
          !current.pendingHandoff
        );
      };
      onUserInput?.(sessionId);
      const promise = applyModelSwitch(
        rpc,
        sessionId,
        () => readScreen(sessionId),
        target.provider,
        target,
        canSwitch,
      ).then(() => {
        if (!canSwitch()) throw new Error('The session changed before the model switch finished');
        if (parsePicker(readScreen(sessionId)))
          throw new Error('Finish the current CLI dialog first');
      });
      modelSwitchPromiseRef.current = promise;
      void promise
        .then(
          () => {
            if (canSwitch()) setPicker(null);
          },
          (error: unknown) => {
            if (!canSwitch()) return;
            setPendingModel(previous);
            setSendErr(
              `Model switch failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        )
        .finally(() => {
          if (modelSwitchPromiseRef.current !== promise) return;
          modelSwitchPromiseRef.current = null;
          switchingRef.current = false;
          setSwitchingModel(false);
        });
    },
    [active, model, pendingHandoff, pendingModel, providerId, rpc, sessionId, onUserInput],
  );

  const send = useCallback(async () => {
    if (pendingHandoff || quickModelOpen) return;
    const raw = draft.trim();
    // The bubble shows what the CLI will receive. session.input converts
    // again; that second pass does not change this text.
    const text = asciiPunctuation(raw);
    const atts = attachments.filter((a) => !a.uploading);
    if (!text && atts.length === 0) return;
    if (attachments.some((a) => a.uploading)) {
      setSendErr('Image still uploading…');
      return;
    }
    const modelSwitchPromise = modelSwitchPromiseRef.current;
    if (modelSwitchPromise) {
      const scope = modelScope.current;
      const sendSessionId = sessionId;
      const sendProviderId = providerId;
      try {
        await modelSwitchPromise;
      } catch {
        return;
      }
      const current = modelContext.current;
      if (
        scope !== modelScope.current ||
        current.sessionId !== sendSessionId ||
        current.providerId !== sendProviderId ||
        !current.active ||
        current.pendingHandoff
      )
        return;
      if (parsePicker(readScreen(sendSessionId))) return;
    } else if (parsePicker(readScreen(sessionId))) {
      return;
    }
    // text first: a message that starts with a path is held back — see composePayload.ts
    const payload = composePayload(
      text,
      atts.map((a) => a.path),
    );
    setDraft((current) => (current === draft ? '' : current));
    setAttachments((current) => current.filter((attachment) => !atts.includes(attachment)));
    setSendErr('');
    // show it NOW: the real record only appears once claude writes the
    // transcript, which is a visible beat later
    const pendingId = ++pendingIdRef.current;
    const userTurns = userTurnsRef.current;
    setPending((prev) => [...prev, { id: pendingId, text: payload, userTurns }]);
    // A message that never comes back must not leave a ghost pulsing forever.
    // But dropping it outright is how a message the person watched leave the
    // box disappeared from the screen with nothing to show for it. So the
    // timer only drops the twin when a record of THEIRS has landed since —
    // the message is in the conversation, just under a text we failed to pair
    // with. If none has, the send itself went nowhere: the bubble stays, and
    // only the pulse stops.
    // A slash command is answered by the CLI itself and may leave no record
    // with its text at all (codex writes nothing for /model — only the new
    // setting), so it gets a short life; its picker, if any, retires it sooner.
    setTimeout(
      () =>
        setPending((prev) =>
          (providerId === 'codex'
            ? rememberScreenQueued(prev, codexQueueRef.current)
            : prev
          ).flatMap((m) => {
            if (m.id !== pendingId) return [m];
            return expireQueuePending(m, providerId, userTurnsRef.current);
          }),
        ),
      payload.startsWith('/') ? 4000 : 60_000,
    );
    // ...and put it in view. On a phone the soft keyboard's resize used to do
    // this by accident; on a desktop nothing did, so a send while scrolled up
    // left the user staring at old history.
    stickToBottom();
    // sent → the box is empty again: collapse the auto-grown height, and
    // on a phone drop the soft keyboard so the reply is readable
    const ta = taRef.current;
    if (ta) ta.style.height = 'auto';
    if (window.matchMedia('(pointer: coarse)').matches) ta?.blur();
    onUserInput?.(sessionId);
    // the session may have sat idle for hours; this send is a new turn, so the
    // terminal's idle streak must not veto the pulse before claude even starts
    setPtyIdleTicks(0);
    // A bracketed paste is stored wrapped in <pasted_content id="…"> and the
    // stream showed those tags as if the user had typed them (verified
    // against a live CLI: the same words written as keystrokes come back
    // clean). So only what NEEDS the paste goes through it — anything with a
    // newline (a \r inside the body would submit half a message) or long
    // enough that claude would fold it anyway. Then the submit-Enter, after
    // the TUI has committed what came before.
    const asPaste = payload.includes('\n') || payload.length > 800;
    // An @mention at the very end can leave the CLI's completion menu open,
    // and then the Enter only accepts the completion — the message sits
    // unsent (absolute and ./ paths, not every time; measured on 2.1.281,
    // docs/stream/at-mention-cli-probe.md). A trailing space closes the
    // mention first; the CLI trims it on submit.
    const typed = /(?:^|\s)@\S/.test(payload) ? `${payload} ` : payload;
    void rpc
      .request('session.input', {
        sessionId,
        data: asPaste ? `\x1b[200~${typed}\x1b[201~` : typed,
      })
      .then((r) => {
        // this client had not heard of the handoff yet: the core kept the
        // message for the successor instead of the dying session
        if (r?.held) setSendErr('Handing off — queued for the new session once it starts');
        setTimeout(() => {
          void rpc.request('session.input', { sessionId, data: '\r' });
        }, 150);
      })
      .catch((e: unknown) => {
        // NEVER swallow this: a phone bound to a restart-orphaned sessionId
        // once lost a user's message here with zero feedback. Put everything
        // back (unless they typed something new) and say why.
        setDraft((d) => (d ? d : raw));
        setAttachments((a) => (a.length ? a : atts));
        setPending((prev) => prev.filter((m) => m.id !== pendingId));
        setSendErr(`Send failed: ${e instanceof Error ? e.message : String(e)}`);
      });
  }, [
    rpc,
    sessionId,
    providerId,
    draft,
    attachments,
    onUserInput,
    pendingHandoff,
    quickModelOpen,
    stickToBottom,
  ]);

  /** A tool_use and its result(s) render as ONE card — the shape every AI
   *  IDE converges on: name + input on the header, output behind a fold. */
  interface ToolGroup {
    use: Turn;
    results: Turn[];
  }
  type ConversationItem = { kind: 'turn'; t: Turn } | { kind: 'toolgroup'; g: ToolGroup };
  type Item = ConversationItem | { kind: 'external_run'; run: ExternalRunDTO };

  /** Group a flat turn list into renderable items. Extracted so a sub-agent's
   *  conversation goes through exactly the same pipeline as the session's own
   *  — tool cards, queued badges, image echoes all behave identically without
   *  a second implementation to keep in step. */
  const buildItems = (list: readonly Turn[]): ConversationItem[] => {
    const items: ConversationItem[] = [];
    // queued messages wait in the tray at the bottom, not in the scrollback
    for (const t of splitQueue(list).conversation) {
      // the harness's image-annotation echo ("[Image: original 1206x2622…]")
      // is pure plumbing — the photo itself already shows in the user bubble
      if (t.role === 'user' && /^\s*\[Image:/.test(t.text)) continue;
      if (t.kind === 'tool_use') {
        const previous = items.at(-1);
        const commentary =
          previous?.kind === 'turn' &&
          previous.t.role === 'assistant' &&
          (previous.t.kind ?? 'text') === 'text' &&
          !previous.t.historical &&
          !previous.t.notice
            ? previous.t.text
            : undefined;
        const use =
          providerId === 'codex' && !t.historical
            ? { ...t, label: codexToolLabel(t, commentary) }
            : t;
        items.push({ kind: 'toolgroup', g: { use, results: [] } });
        continue;
      }
      if (t.role === 'tool') {
        // a result answers the call its id names: parallel calls (a Bash and
        // a Monitor in one message) put both results after the LAST card, and
        // pairing by order gave the Bash's result to the Monitor
        const owner =
          t.toolUseId && !t.historical
            ? items.findLast(
                (it): it is Extract<ConversationItem, { kind: 'toolgroup' }> =>
                  it.kind === 'toolgroup' && it.g.use.toolUseId === t.toolUseId,
              )
            : undefined;
        if (owner) {
          owner.g.results.push(t);
          continue;
        }
        // a legacy "[result] …" record: attach to the open card when one
        // exists, else render standalone
        const last = items[items.length - 1];
        if (
          !t.historical &&
          last?.kind === 'toolgroup' &&
          !last.g.use.historical &&
          last.g.results.length < 4
        ) {
          last.g.results.push(t);
          continue;
        }
        items.push({ kind: 'turn', t });
        continue;
      }
      items.push({ kind: 'turn', t });
    }
    return items;
  };
  const conversationItems = buildItems(displayTurns);
  const items: Item[] = insertExternalRuns(
    conversationItems,
    externalRuns,
    (item) => (item.kind === 'toolgroup' ? item.g.use.at : item.t.at),
  );
  // what claude has queued and not taken up yet — task notifications queue
  // too, but they are not the user's words
  // task notifications and the like queue too; the user's own words stay.
  // (Not "starts with <": a message pasted into the box arrives wrapped in
  // <pasted_content> and vanished from the tray — 09-21.)
  // taken back with Up but not yet confirmed by the CLI's popAll records
  // (the transcript is read every 1.5s): hidden, so a second Up cannot pull
  // the same messages twice
  const pulledRef = useRef(new Set<string>());
  const tray = splitQueue(turns)
    .tray.filter((t) => !MACHINE_QUEUED_RE.test(t.text))
    .filter((t) => !pulledRef.current.has(keyOf(t)));
  const hiddenPending =
    providerId === 'codex' ? screenQueuedIds(pending, codexQueue) : new Set<number>();
  // Up on the composer's first line while messages wait in the queue: the
  // CLI's own Up — every queued message comes back to be edited, oldest
  // first, the draft after them, one newline between (measured on 2.1.281,
  // docs/stream/queue-edit-cli-probe.md). The CLI is told to let go of them
  // (its popAll records clear the tray) and its own box is emptied again.
  const pullQueued = (ta: HTMLTextAreaElement): boolean => {
    if (providerId === 'codex') return false;
    if (!working || tray.length === 0) return false;
    if (ta.value.slice(0, ta.selectionStart).includes('\n')) return false; // not the first line
    for (const t of tray) pulledRef.current.add(keyOf(t));
    const queued = tray.map((t) => t.text);
    const next = asciiPunctuation([...queued, draft].filter((x) => x !== '').join('\n'));
    // Backspaces for what Up put in the TUI's box — generously: a message
    // that went in as a paste may show as a longer placeholder, and extra
    // Backspaces on an empty box do nothing
    const clearChars = queued.join('\n').length + 40 * queued.length;
    void rpc.request('session.pullQueue', { sessionId, clearChars }).catch((err: unknown) => {
      setSendErr(
        `Could not take the queue back: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    setDraft(next);
    requestAnimationFrame(() => {
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
      ta.setSelectionRange(next.length, next.length);
    });
    return true;
  };

  // One fold open at a time: at most one command run, and at most one card
  // (inside that run or on its own). Opening something else closes what was
  // open; typing in the composer closes everything.
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const collapseAll = (): void => {
    setOpenRun(null);
    setOpenCard(null);
  };
  /** props for a controlled <details> card; `runId` = the run it sits in */
  const fold = (id: string, runId: string | null) => ({
    open: openCard === id,
    onSummaryClick: (e: React.MouseEvent): void => {
      e.preventDefault(); // we own the open state, not the browser
      setOpenCard(openCard === id ? null : id);
      setOpenRun(runId);
    },
  });

  useEffect(() => {
    if (!active || !sessionId) return;
    let alive = true;
    const load = (): void => {
      void rpc
        .request('session.subagents', { sessionId })
        .then((r) => {
          if (!alive) return;
          setKnownAgents(new Set(r.agents.map((a) => a.agentId)));
          setAgentList(r.agents);
        })
        .catch(() => {});
      void rpc
        .request('session.bgShells', { sessionId })
        .then((r) => alive && setKnownShells(new Map(r.shells.map((x) => [x.id, x]))))
        .catch(() => {});
    };
    load();
    // new sub-agents appear mid-turn, and a running command's progress moves;
    // the list is a handful of files and a tail each
    const id = setInterval(load, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [rpc, sessionId, active]);

  useEffect(() => {
    const agentId = subagent?.agentId;
    if (!agentId || !sessionId) return;
    let alive = true;
    const load = (): void => {
      void rpc
        .request('session.subagentTranscript', { sessionId, agentId })
        .then((r) => alive && setSubTurns(r.turns))
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [rpc, sessionId, subagent?.agentId]);

  useEffect(() => {
    const id = bgShell?.id;
    if (!id || !sessionId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (): void => {
      void rpc
        .request('session.bgShellOutput', { sessionId, id })
        .then((r) => {
          if (!alive) return;
          setBgOut(r);
          // a finished command will never change again — stop asking
          if (!r.done) timer = setTimeout(load, 1500);
        })
        .catch(() => {
          if (alive) timer = setTimeout(load, 3000);
        });
    };
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [rpc, sessionId, bgShell?.id]);

  /** Talk to a sub-agent. There is no socket to it: the only way in is the
   *  parent, which owns it and can pass a message on with SendMessage. So the
   *  text is addressed to the parent, and the note below the box says so
   *  rather than pretending it went straight through. */
  const sendToSubagent = useCallback(async (): Promise<void> => {
    const body = subText.trim();
    const agentId = subagent?.agentId;
    if (!body || !agentId) return;
    setSubText('');
    setSubNote('Passed on — waiting for the parent session…');
    const line = asciiPunctuation(
      `用 SendMessage 把下面这段转给 agent ${agentId}（summary 写 5-10 词概要），然后把它的回应告诉我：\n${body}`,
    );
    try {
      await rpc.request('session.input', { sessionId, data: line });
      // text and Return must be two writes — one combined write leaves the
      // prompt sitting in the input box unsubmitted (measured, see notes)
      await rpc.request('session.input', { sessionId, data: '\r' });
      setSubNote('Sent to the parent session to relay');
    } catch (e) {
      setSubText(body); // hand it back rather than swallow it
      setSubNote(`Not sent: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [rpc, sessionId, subText, subagent?.agentId]);

  const timeOf = (t: Turn): string => {
    const d = new Date(t.at);
    return Number.isNaN(d.getTime())
      ? ''
      : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const renderUserText = (text: string): JSX.Element => {
    // uploaded photos render as the actual image, not as path noise
    let chips: readonly string[] = text.match(UPLOAD_PATH_RE) ?? [];
    let rest = text.replace(UPLOAD_PATH_RE, '').replace(/\s+/g, ' ').trim();
    if (chips.length === 0 && /\[Image #\d+\]/.test(text)) {
      const carried = carriedImages.current.get(messageBody(text));
      if (carried) {
        chips = carried;
        rest = rest.replace(/\[Image #\d+\]/g, '').trim();
      }
    }
    const words = rest === ATTACHED_PREFIX ? '' : rest;
    return (
      <>
        {chips.map((c) => (
          <UploadThumb key={c} rpc={rpc} path={c} onOpen={openViewer} />
        ))}
        {words && <span className="sv-user-text">{words}</span>}
      </>
    );
  };

  /** The agentId an Agent card launched. It is not in the tool INPUT — only
   *  the result announces it ("agentId: a1522…"), so that is where to look. */
  const agentIdOf = (g: ToolGroup): string | undefined => {
    for (const r of g.results) {
      const m = /agentId:\s*([A-Za-z0-9_-]{6,})/.exec(r.text);
      if (m?.[1] && knownAgents.has(m[1])) return m[1];
    }
    return undefined;
  };

  /** The task id a backgrounded command was given. Like the agentId, it is
   *  only in the RESULT — "Command running in background with ID: …". */
  const bgIdOf = (g: ToolGroup): string | undefined => {
    for (const r of g.results) {
      const m = /background with ID:\s*([A-Za-z0-9_-]{3,})/.exec(r.text);
      if (m?.[1] && knownShells.has(m[1])) return m[1];
    }
    return undefined;
  };

  const renderToolGroup = (
    g: ToolGroup,
    key: string,
    isLast: boolean,
    runId: string | null = null,
  ): JSX.Element => {
    if (g.use.historical) {
      return (
        <HistoricalToolCard
          key={key}
          name={g.use.toolName}
          input={g.use.text}
          label={g.use.label}
          output={g.results.length ? g.results.map((r) => r.text).join('\n') : undefined}
          onOpenPath={onOpenPath ? (path) => onOpenPath(path, cwd) : undefined}
        />
      );
    }
    {
      const bgId = bgIdOf(g);
      if (bgId) {
        const shell = knownShells.get(bgId);
        const running = shell?.done === false;
        return (
          <button
            type="button"
            key={key}
            className={`sv-tool sv-subagent-door${running ? ' running' : ''}`}
            onClick={() => {
              setBgOut(null);
              setBgShell({ id: bgId, head: g.use.label || firstLine(g.use.text) });
            }}
            title={running ? 'Still running — open to see output' : 'Finished — open to see output'}
          >
            <span className="sv-tool-dot">{IconTool}</span>
            <span className="sv-tool-name">{running ? 'Running' : 'Done'}</span>
            {running && (shell?.progress || shell?.startedAtMs) && (
              <span className="sv-tool-count">
                {progressText(shell.progress) ||
                  (shell.startedAtMs ? sinceText(new Date(shell.startedAtMs).toISOString()) : '')}
              </span>
            )}
            <span className={`sv-tool-input${g.use.label ? ' named' : ''}`} title={g.use.text}>
              {g.use.label || firstLine(g.use.text)}
            </span>
            <span className="sv-subagent-go">›</span>
          </button>
        );
      }
    }
    if (g.use.toolName === 'Agent') {
      const agentId = agentIdOf(g);
      const task = g.use.text.replace(/\s+/g, ' ').trim();
      // Only a door when the conversation is actually on disk — a card that
      // looks clickable and opens nothing is worse than a plain card.
      if (agentId) {
        return (
          <button
            type="button"
            key={key}
            className="sv-tool sv-subagent-door"
            onClick={() => {
              setSubTurns([]);
              setSubNote('');
              setSubagent({ agentId, task });
            }}
            title="Open this sub-agent's conversation"
          >
            <span className="sv-tool-dot">{IconTool}</span>
            <span className="sv-tool-name">Agent</span>
            <span className="sv-tool-input">{task.slice(0, 80)}</span>
            <span className="sv-subagent-go">›</span>
          </button>
        );
      }
    }
    if (g.use.toolName === 'AskUserQuestion') {
      let qs: AskQuestion[] = [];
      try {
        const parsed = JSON.parse(g.use.text) as { questions?: AskQuestion[] };
        qs = (parsed.questions ?? []).filter((q) => q?.question && Array.isArray(q.options));
      } catch {
        /* fall through to the generic card */
      }
      if (qs.length > 0) {
        const rawAnswer = g.results.map((r) => r.text).join('\n');
        const answer = cleanAnswer(rawAnswer);
        // one answer under each question; a text that does not follow the form stays whole
        const answers = g.results.length > 0 ? splitAnswers(rawAnswer, qs) : null;
        return (
          <QuestionCard
            key={key}
            questions={qs}
            answerText={g.results.length > 0 ? answer || 'Answered' : ''}
            answers={answers ?? undefined}
            active={isLast && g.results.length === 0}
            awaitingSubmit={awaitingSubmit}
            sendKey={sendSeq}
            sendNext={() => {
              // Enter on an option ticks it; a multi-select moves on from its Next row
              const current = parsePicker(readScreen(sessionId));
              sendSeq(current?.multi ? `${keysToNext(current)}\r` : '\r');
            }}
          />
        );
      }
    }
    const out = g.results
      .map((r) => r.text)
      .join('\n')
      .trim();
    const outLines = out ? out.split('\n').length : 0;
    // an Edit/Write says only "has been updated"; the change itself rides on
    // the result, and opened it should read like the terminal's diff
    const patch = g.results.find((r) => r.patch)?.patch;
    const viewed = isViewedImageTool(g.use.toolName, g.use.label);
    const shot = imageArg(g.use.text, cwd, g.use.toolName, g.use.label);
    const viewedName = shot ? viewedImageBasename(shot) : undefined;
    const signed = (sign: string): number =>
      (patch ?? []).reduce(
        (n, fp) =>
          n + fp.hunks.reduce((m, h) => m + h.lines.filter((l) => l.startsWith(sign)).length, 0),
        0,
      );
    const added = patch ? signed('+') : 0;
    const removed = patch ? signed('-') : 0;
    const changed = added + removed;
    const f = fold(`card:${keyOf(g.use)}`, runId);
    // The newest call with no answer yet is the one running now. Without a
    // mark it looked exactly like a finished call that printed nothing — a
    // long MCP call sat there reading as done. Pulse + clock, as a run does.
    const startedMs = Date.parse(g.use.at);
    const inFlight = isLast && working && g.results.length === 0;
    const runningFor =
      inFlight && Number.isFinite(startedMs)
        ? fmtSeconds(Math.max(0, Math.round((Date.now() - startedMs) / 1000)))
        : undefined;
    return (
      <details key={key} className={`sv-tool${viewed ? ' sv-viewed-image' : ''}`} open={f.open}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: a <summary> turns Enter/Space into this click natively */}
        <summary onClick={f.onSummaryClick}>
          <span className="sv-tool-dot">
            {inFlight ? <span className="sv-run-pulse" /> : IconTool}
          </span>
          <span className="sv-tool-name">
            {viewed ? 'Viewed image' : (g.use.toolName ?? 'tool')}
          </span>
          {viewed && viewedName ? (
            // Codex TUI: "Viewed image <basename>" — path opens on click
            <button
              type="button"
              className="sv-tool-input sv-viewed-image-file"
              title={shot ?? viewedName}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (shot) onOpenPath?.(shot, cwd);
              }}
            >
              {viewedName}
            </button>
          ) : (
            g.use.text && (
              // claude's own name for the call reads better than a command
              // opening with `LOG=/private/tmp/…`; the command is one click away
              <span
                className={`sv-tool-input${g.use.label ? ' named' : ''}`}
                title={g.use.label ? g.use.text : undefined}
              >
                {g.use.label || firstLine(g.use.text)}
              </span>
            )
          )}
          {pendingShell?.key === keyOf(g.use) && (
            <span className="sv-tool-count">
              {progressText(pendingShell.shell.progress) || 'running…'}
            </span>
          )}
          {runningFor !== undefined && <span className="sv-tool-count">{runningFor}</span>}
          {changed > 0 ? (
            // a new file is all additions and a deletion-only edit all
            // removals — "163 + 0 -" reads like a diff that lost a side
            <span className="sv-tool-count">
              {added > 0 && `${added} +`}
              {added > 0 && removed > 0 && ' '}
              {removed > 0 && `${removed} -`}
            </span>
          ) : (
            outLines > 0 && (
              <span className="sv-tool-count">
                {outLines === 1 ? '1 line' : `${outLines} lines`}
              </span>
            )
          )}
          {shot && (
            // the click belongs to the picture, not to the fold: without this
            // opening the viewer would also toggle the card
            // biome-ignore lint/a11y/useKeyWithClickEvents: the thumb inside carries its own keyboard handler
            <span
              className="sv-tool-thumb"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <UploadThumb rpc={rpc} path={shot} onOpen={openViewer} chipWhenMissing={false} />
            </span>
          )}
        </summary>
        {shot && (
          // opened, the card shows the picture at reading size; the row keeps its small chip
          <div className="sv-tool-shot">
            <UploadThumb rpc={rpc} path={shot} onOpen={openViewer} chipWhenMissing={false} />
          </div>
        )}
        {viewed && shot && (
          <div className="sv-viewed-image-path">
            {onOpenPath ? (
              <button type="button" className="sv-historical-path" onClick={() => onOpenPath(shot, cwd)}>
                {shot}
              </button>
            ) : (
              shot
            )}
          </div>
        )}
        {patch && <DiffView patch={patch} onOpenFile={(f) => onOpenPath?.(f, cwd)} />}
        {!viewed &&
          g.use.text &&
          (patch ? (
            <details>
              <summary>Raw tool input</summary>
              <pre className="sv-tool-pre">{g.use.text}</pre>
            </details>
          ) : (
            <pre className="sv-tool-pre">{g.use.text}</pre>
          ))}
        {/* an Edit/Write's own result only restates the diff ("has been
            updated"); a bash command that edited a file may also have
            printed something worth reading, so keep that.
            Codex ImageView's "[completed]" is noise next to the picture. */}
        {!viewed &&
          (!patch || (out && !WRITES_FILES.has(g.use.toolName ?? ''))) && (
            <pre className="sv-tool-pre">{out || '(no output)'}</pre>
          )}
      </details>
    );
  };

  const renderItem = (
    it: Item,
    i: number,
    prev?: Item,
    lastConversationIndex = lastConversationItemIndex(items),
    runId: string | null = null,
  ): JSX.Element => {
    if (it.kind === 'external_run')
      return <ExternalRunCard key={`mcp-${it.run.executionId}`} run={it.run} />;
    if (it.kind === 'toolgroup')
      return renderToolGroup(
        it.g,
        `g${it.g.use.seq}-${keyOf(it.g.use)}`,
        i === lastConversationIndex,
        runId,
      );
    const t = it.t;
    const key = `${t.seq}-${keyOf(t)}`;
    if (t.historical && t.role === 'tool') {
      return (
        <HistoricalToolCard
          key={key}
          input={t.text}
          result
          onOpenPath={onOpenPath ? (path) => onOpenPath(path, cwd) : undefined}
        />
      );
    }
    if (t.kind === 'thinking') {
      // duration ≈ gap to the previous record — the same number the TUI
      // prints as "Cogitated for …" (clamped to a sane range)
      const prevAt = prev
        ? Date.parse(
            prev.kind === 'toolgroup'
              ? (prev.g.results[prev.g.results.length - 1] ?? prev.g.use).at
              : prev.kind === 'external_run'
                ? prev.run.startedAt
                : prev.t.at,
          )
        : Number.NaN;
      const gapS = Math.round((Date.parse(t.at) - prevAt) / 1000);
      const dur =
        Number.isFinite(gapS) && gapS >= 2 && gapS < 1800
          ? gapS >= 60
            ? ` ${Math.floor(gapS / 60)}m${String(gapS % 60).padStart(2, '0')}s`
            : ` ${gapS}s`
          : '';
      // shown whole, not folded to one cut line: between commands the thinking
      // is what says what the session is doing and why
      return (
        <div key={key} className="sv-think">
          <div className="sv-think-head">
            {/* icon + how long, no words — the thought itself follows */}
            <span className="sv-think-ic" title="Thought">
              {IconThink}
            </span>{' '}
            {dur.trim()}
          </div>
          <div className="sv-think-body">{t.text}</div>
        </div>
      );
    }
    if (t.role === 'tool') {
      // legacy / orphan result
      const f = fold(`card:${keyOf(t)}`, runId);
      return (
        <details key={key} className="sv-tool" open={f.open}>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: a <summary> turns Enter/Space into this click natively */}
          <summary onClick={f.onSummaryClick}>
            <span className="sv-tool-dot">{IconTool}</span>
            <span className="sv-tool-input">{firstLine(t.text)}</span>
          </summary>
          <pre className="sv-tool-pre">{t.text}</pre>
        </details>
      );
    }
    if (t.role === 'system') {
      return (
        <div key={key} className="sv-system">
          {firstLine(t.text)}
        </div>
      );
    }
    if (t.role === 'user') {
      // the resume nudge is a SEAM, not a message: it marks where the app
      // restarted and the conversation picked back up
      if (/^\s*Continue from where you left off\.?\s*$/i.test(t.text)) {
        return (
          <div key={key} className="sv-seam" title={timeOf(t)}>
            <span>Session resumed{timeOf(t) && ` · ${timeOf(t)}`}</span>
          </div>
        );
      }
      // machine-injected records (task notifications, system reminders,
      // slash-command transcripts) are not something the person typed —
      // render them as a dim system line, not a user bubble full of
      // XML-escaped noise
      // another session talking to this one reads as a person talking: a face,
      // their name, and what they said
      const fromSession = crossSessionMessage(t.text);
      if (fromSession) {
        return (
          <div key={key} className="sv-turn sv-from-session" title={timeOf(t)}>
            <img
              className="sv-from-ava"
              src={avatarSrc(avatarOfSession?.(fromSession.from) ?? avatarFor(fromSession.from))}
              alt=""
            />
            <div className="sv-from-col">
              <div className="sv-from-name">{fromSession.from}</div>
              <div
                className="sv-md sv-from-body"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: same as the assistant messages — the session's own transcript
                dangerouslySetInnerHTML={{
                  __html: markCodePaths(marked.parse(fromSession.body, { async: false }) as string),
                }}
              />
            </div>
          </div>
        );
      }
      const handBack = agentMessage(t.text);
      if (handBack) {
        const f = fold(`card:${keyOf(t)}`, runId);
        const canOpen = knownAgents.has(handBack.from);
        return (
          <details key={key} className="sv-tool sv-agent-report" open={f.open} title={timeOf(t)}>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: a <summary> turns Enter/Space into this click natively */}
            <summary onClick={f.onSummaryClick}>
              <span className="sv-tool-dot">{IconTool}</span>
              <span className="sv-tool-name">Sub-agent report</span>
              <span className="sv-tool-input">{firstLine(handBack.report)}</span>
            </summary>
            <div
              className="sv-md sv-agent-report-body"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: same as the assistant messages — the session's own transcript
              dangerouslySetInnerHTML={{
                __html: markCodePaths(marked.parse(handBack.report, { async: false }) as string),
              }}
            />
            {canOpen && (
              <button
                type="button"
                className="sv-agent-report-open"
                onClick={() => {
                  setSubTurns([]);
                  setSubNote('');
                  setSubagent({ agentId: handBack.from, task: firstLine(handBack.report) });
                }}
              >
                Open this sub-agent's conversation ›
              </button>
            )}
          </details>
        );
      }
      if (t.injected === 'handoff' || t.injected === 'compaction') {
        return (
          <InjectedUserTurnCard key={key} kind={t.injected} timeTitle={timeOf(t)}>
            {t.text}
          </InjectedUserTurnCard>
        );
      }
      // The harness's own injections arrive as "user" records: a loaded
      // skill's body, a /context report, the notice that a response was cut
      // short. `meta` is the harness's own label for them — the patterns are
      // kept for records written before it was read. Dressed in the person's
      // bubble they read as something they said, which they did not.
      if (
        t.meta ||
        /^\s*<(?:task-notification|system-reminder|command-name|local-command)/.test(t.text) ||
        /^\s*Base directory for this skill:/.test(t.text) ||
        /^\s*\[Ateam\b/.test(t.text) ||
        /^\s*##\s*Context Usage/.test(t.text)
      ) {
        // '' = plumbing with nothing worth a line; null = labelled machine
        // text we have no short form for, which is still better shown than
        // silently dropped
        const line = machineLine(t.text) ?? firstLine(t.text);
        if (!line) return <span key={key} />;
        return (
          <div key={key} className="sv-system" title={timeOf(t)}>
            {line.length > 140 ? `${line.slice(0, 140)}…` : line}
          </div>
        );
      }
      if (t.injected === 'mid_turn') {
        return (
          <InjectedUserTurnCard key={key} kind="mid_turn" timeTitle={timeOf(t)}>
            {renderUserText(t.text)}
          </InjectedUserTurnCard>
        );
      }
      return (
        <div key={key} className="sv-turn sv-user" title={timeOf(t)}>
          <div className="sv-bubble">{renderUserText(t.text)}</div>
        </div>
      );
    }
    if (t.notice) {
      // the harness reporting on the turn (API error, usage limit, interrupt)
      // — the terminal prints these in red; they are not the model's answer
      return (
        <div key={key} className={`sv-notice sv-notice-${t.notice}`} title={timeOf(t)}>
          {t.text}
        </div>
      );
    }
    /* A chart claude just wrote is worth SEEING, not just reading the path
       of. Each picture sits after the block that NAMES it, not at the end of
       the message: an answer that opens with "the comparison is in `x.png`"
       and then runs ten lines of table put the one thing the sentence points
       at furthest from it. */
    const parts = splitAtPictures(t.text, cwd);
    return (
      <div key={key} className="sv-turn sv-assistant" title={timeOf(t)}>
        {/* .sv-turn is a flex ROW (it is what pushes a user bubble right and
            an answer left), so the text and the pictures must not be its
            children directly: an inline chart is as wide as the row and would
            squeeze the prose beside it to nothing — one character per line.
            They stack in a column of their own instead. */}
        <div className="sv-assistant-col">
          {parts.map((part, pi) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one message are positional; there is no id to key by
            <Fragment key={pi}>
              {part.md.trim() && (
                <div
                  className="sv-md"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: same pattern as FileView's markdown preview; transcript text is the user's own conversation
                  dangerouslySetInnerHTML={{
                    __html: markCodePaths(marked.parse(part.md, { async: false }) as string),
                  }}
                />
              )}
              {part.images.map((p) => (
                <UploadThumb
                  key={p}
                  rpc={rpc}
                  path={p}
                  onOpen={openViewer}
                  chipWhenMissing={false}
                />
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    );
  };

  const isCommand = (it: Item | undefined): it is Extract<ConversationItem, { kind: 'toolgroup' }> =>
    it?.kind === 'toolgroup' &&
    canGroupTool(providerId, it.g.use, !!bgIdOf(it.g) || !!agentIdOf(it.g));
  const isThinking = (it: Item | undefined): boolean =>
    it?.kind === 'turn' && it.t.kind === 'thinking';

  /** A run of shell commands as ONE row: "执行命令 N: <current>" while it is
   *  still going, "执行 N 条命令" once done; open it to get the cards back. */
  const renderRun = (
    run: Run<number>,
    list: readonly Item[],
    sessionBusy: boolean,
    lastConversationIndex: number,
  ): JSX.Element => {
    const cmds = run.items.map((i) => list[i]).filter(isCommand);
    const first = cmds[0] as Extract<ConversationItem, { kind: 'toolgroup' }>;
    const last = cmds[cmds.length - 1] as Extract<ConversationItem, { kind: 'toolgroup' }>;
    const runId = `run:${keyOf(first.g.use)}`;
    const end = run.items[run.items.length - 1] ?? 0;
    // still going = nothing but thinking after it, and either the session is
    // busy or its last command has not answered yet
    const live =
      list.slice(end + 1).every(isThinking) && (sessionBusy || last.g.results.length === 0);
    const open = openRun === runId;
    // the last command itself still running: its clock ticks (the working
    // row's 1s tick re-renders) and its newest output line shows underneath
    const commandRunning = live && last.g.results.length === 0;
    const startedMs = Date.parse(last.g.use.at);
    const runningFor =
      commandRunning && Number.isFinite(startedMs)
        ? fmtSeconds(Math.max(0, Math.round((Date.now() - startedMs) / 1000)))
        : undefined;
    const shell =
      commandRunning && pendingShell?.key === keyOf(last.g.use) ? pendingShell.shell : undefined;
    const liveOut = shell
      ? [progressText(shell.progress), plainLine(shell.lastLine ?? '')].filter(Boolean).join(' · ')
      : '';
    return (
      <details key={runId} className="sv-tool sv-run" open={open}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: a <summary> turns Enter/Space into this click natively */}
        <summary
          onClick={(e) => {
            e.preventDefault();
            setOpenRun(open ? null : runId);
            setOpenCard(null);
          }}
        >
          <span className="sv-tool-dot">{live ? <span className="sv-run-pulse" /> : IconTool}</span>
          <span className="sv-tool-name">
            {providerId === 'codex'
              ? live
                ? `Running tool ${run.commands}:`
                : `Ran ${run.commands} tools`
              : live
                ? `Running command ${run.commands}:`
                : `Ran ${run.commands} ${run.commands === 1 ? 'command' : 'commands'}`}
          </span>
          {live && (
            // claude's name for the call — "python3 - <<'EOF'" says nothing
            <span
              className={`sv-tool-input${last.g.use.label ? ' named' : ''}`}
              title={last.g.use.text}
            >
              {last.g.use.label || firstLine(last.g.use.text)}
            </span>
          )}
          {runningFor !== undefined && <span className="sv-tool-count">{runningFor}</span>}
          <span className="sv-run-chev">›</span>
          {/* what the command is printing right now: a folded row that only
              names the command sat still for minutes and looked stuck */}
          {liveOut && <span className="sv-run-out">{liveOut}</span>}
        </summary>
        {open && (
          <div className="sv-run-body">
            {run.items.map((i) =>
              renderItem(list[i] as Item, i, list[i - 1], lastConversationIndex, runId),
            )}
          </div>
        )}
      </details>
    );
  };

  const renderList = (list: readonly Item[], sessionBusy: boolean): JSX.Element[] => {
    const lastConversationIndex = lastConversationItemIndex(list);
    return groupToolRuns(
      list.map((_, i) => i),
      (i) => isCommand(list[i]),
    ).map((e) =>
      isRun(e)
        ? renderRun(e, list, sessionBusy, lastConversationIndex)
        : renderItem(list[e] as Item, e, list[e - 1], lastConversationIndex),
    );
  };

  // Between the user's send and the model's text there is only silence —
  // every AI chat shows a "working" pulse there, and so do we: the last
  // meaningful turn not being assistant TEXT means claude owes us one.
  const lastMeaningful = [...turns].reverse().find((t) => t.kind !== 'thinking');
  const owesAnswer =
    lastMeaningful !== undefined &&
    !(lastMeaningful.role === 'assistant' && (lastMeaningful.kind ?? 'text') === 'text') &&
    lastMeaningful.role !== 'system' &&
    // A LOCAL slash command (/model, /clear, /context) is answered by the CLI
    // itself — the answer is right there in the record — so nothing is coming
    // and the pulse would never stop. A slash command that expands into a
    // PROMPT has no local-command-stdout and still gets a real reply.
    !LOCAL_COMMAND_DONE.test(lastMeaningful.text);
  // …and the terminal gets a veto: a turn can end without ever writing an
  // assistant record (picker cancelled, Esc interrupt, claude died), and the
  // records alone would pulse forever. See streamPulse.ts.
  const working =
    !loading &&
    (turns.length > 0 || (providerId === 'codex' && (pending.length > 0 || ptyBusy === true))) &&
    shouldPulse({
      owesAnswer:
        owesAnswer ||
        (providerId === 'codex' && pending.some((message) => !message.text.startsWith('/'))),
      sawBusyHint: sawBusyHintRef.current,
      idleTicks: ptyIdleTicks,
      providerId,
      screenBusy: ptyBusy,
      waitingForInput: picker !== null,
    });
  // …with the numbers the TUI shows: elapsed since the user's send, and
  // output tokens accumulated across this turn's records so far
  let turnStartMs = 0;
  let turnTokens = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (!t) break;
    if (t.role === 'user' && (t.kind ?? 'text') === 'text' && !/^\s*</.test(t.text)) {
      turnStartMs = Date.parse(t.at) || 0;
      break;
    }
    turnTokens += t.tokens ?? 0;
  }
  const [nowTick, setNowTick] = useState(0);
  // background work outlives the turn: its clocks keep ticking after it
  const liveBackground =
    [...knownShells.values()].some((sh) => !sh.done && !sh.statusUnknown) ||
    agentList.some((a) => a.done === false);
  useEffect(() => {
    if (!working && !liveBackground) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [working, liveBackground]);
  void nowTick;
  // One line per wait, swapped every 12s if the wait outlasts that. Picked in
  // an effect keyed on `working` rather than during render, so the 1s elapsed
  // tick can't reshuffle it under the reader mid-sentence.
  const [foxLine, setFoxLine] = useState(0);
  const foxLineRef = useRef(0);
  useEffect(() => {
    if (!working) return;
    const pick = (): void => {
      let n = foxLineRef.current;
      // never the same line twice running — a repeat reads as a stuck UI
      while (FOX_LINES.length > 1 && n === foxLineRef.current)
        n = Math.floor(Math.random() * FOX_LINES.length);
      foxLineRef.current = n;
      setFoxLine(n);
    };
    pick();
    const id = setInterval(pick, 12000);
    return () => clearInterval(id);
  }, [working]);
  const elapsedS =
    working && turnStartMs > 0 ? Math.max(0, Math.round((Date.now() - turnStartMs) / 1000)) : 0;
  const fmtElapsed =
    elapsedS >= 60
      ? `${Math.floor(elapsedS / 60)}m${String(elapsedS % 60).padStart(2, '0')}s`
      : `${elapsedS}s`;
  const fmtTokens = turnTokens >= 1000 ? `${(turnTokens / 1000).toFixed(1)}k` : String(turnTokens);

  /* What the terminal prints once a turn lands — "Churned for 24s · done
     3:15 PM · 1 shell still running". The stream showed the elapsed clock
     only WHILE working, so the moment an answer arrived every trace of how
     long it took, and of what it left running, disappeared. Captured on the
     working→idle edge, from the transcript's own timestamps rather than when
     this component noticed. */
  const [lastDone, setLastDone] = useState<{ seconds: number; at: number } | null>(null);
  const wasWorkingRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: edge-triggered on `working`
  useEffect(() => {
    const was = wasWorkingRef.current;
    wasWorkingRef.current = working;
    if (working) {
      setLastDone(null); // a new turn: the previous one's summary is stale
      return;
    }
    if (!was) return;
    const endedAt = Date.parse(turns[turns.length - 1]?.at ?? '') || Date.now();
    const startedAt = turnStartMs || endedAt;
    setLastDone({ seconds: Math.max(0, Math.round((endedAt - startedAt) / 1000)), at: endedAt });
  }, [working]);
  const runningShellList = [...knownShells.values()].filter((sh) => !sh.done && !sh.statusUnknown);
  const runningShells = runningShellList.length;
  // watchers are listed in the bar but are not "commands still running"
  const runningCommands = runningShellList.filter((sh) => !sh.monitor).length;
  // sub-agents still working — the terminal lists them under its prompt; the
  // stream only had their Agent cards, long scrolled away
  const runningAgents = agentList.filter((a) => a.done === false);
  const runningAgentIds = new Set(runningAgents.map((a) => a.agentId));
  // commands and watchers a running sub-agent started: drawn in its row
  const shellsByAgent = new Map<string, BgShellDTO[]>();
  for (const sh of runningShellList) {
    if (!sh.agentId || !runningAgentIds.has(sh.agentId)) continue;
    shellsByAgent.set(sh.agentId, [...(shellsByAgent.get(sh.agentId) ?? []), sh]);
  }
  const openShell = (sh: BgShellDTO): void => {
    setBgOut(null);
    setBgShell({ id: sh.id, head: sh.label || shellCommand.get(sh.id) || sh.head });
  };
  /** a sub-agent's task as small lines inside the agent's row: its name and
   *  figure (or latest line, or how long it has run), then one line per log
   *  it reads, with a short bar. A span, not a button — it sits inside the
   *  agent's button — so it stops the click that would open the agent. */
  const childLines = (sh: BgShellDTO): JSX.Element => {
    const name = sh.label || shellCommand.get(sh.id) || plainLine(sh.head) || sh.id;
    const figure =
      progressText(sh.progress) ||
      (sh.lastLine ? plainLine(sh.lastLine) : '') ||
      (sh.startedAtMs ? sinceText(new Date(sh.startedAtMs).toISOString()) : '');
    return (
      <Fragment key={sh.id}>
        <span
          role="button"
          tabIndex={0}
          className="sv-bgbar-child"
          title="Open its output"
          onClick={(e) => {
            e.stopPropagation();
            openShell(sh);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.stopPropagation();
            openShell(sh);
          }}
        >
          {sh.monitor && <span className="sv-bgbar-child-kind">Monitor</span>}
          <span className="sv-bgbar-child-name">{name}</span>
          {figure && <span className="sv-bgbar-child-fig">{figure}</span>}
        </span>
        {sh.sources?.map((src) => (
          <span key={src.name} className="sv-bgbar-child sv-bgbar-child-src">
            <span className="sv-bgbar-child-name" title={src.name}>
              {src.name.split('/').pop()}
            </span>
            {src.progress.pct !== undefined && (
              <span className="sv-bgbar-minitrack">
                <span className="sv-bgbar-fill" style={{ width: `${src.progress.pct}%` }} />
              </span>
            )}
            <span className="sv-bgbar-child-fig">{progressText(src.progress)}</span>
          </span>
        ))}
      </Fragment>
    );
  };
  const shellRow = (sh: BgShellDTO): JSX.Element => (
    <button
      type="button"
      key={sh.id}
      className="sv-bgbar-item"
      title="Open its output"
      onClick={() => {
        setBgOut(null);
        setBgShell({ id: sh.id, head: sh.label || shellCommand.get(sh.id) || sh.head });
      }}
    >
      <span className="sv-bgbar-top">
        <span className="sv-bgbar-dot" />
        {sh.monitor && <span className="sv-bgbar-kind">Monitor</span>}
        <span className="sv-bgbar-cmd">
          {sh.label || shellCommand.get(sh.id) || plainLine(sh.head) || sh.id}
        </span>
        {sh.lastLine && <span className="sv-bgbar-line">{plainLine(sh.lastLine)}</span>}
        {/* no progress figure: at least how long it has been going */}
        <span className="sv-bgbar-num">
          {progressText(sh.progress) ||
            (sh.startedAtMs ? sinceText(new Date(sh.startedAtMs).toISOString()) : '')}
        </span>
      </span>
      {sh.progress?.pct !== undefined && (
        <span className="sv-bgbar-track">
          <span className="sv-bgbar-fill" style={{ width: `${sh.progress.pct}%` }} />
        </span>
      )}
      {/* one bar per log it reads, named by the log's file name */}
      {sh.sources?.map((src) => (
        <span key={src.name} className="sv-bgbar-src">
          <span className="sv-bgbar-src-top">
            <span className="sv-bgbar-src-name" title={src.name}>
              {src.name.split('/').pop()}
            </span>
            <span className="sv-bgbar-num">{progressText(src.progress)}</span>
          </span>
          {src.progress.pct !== undefined && (
            <span className="sv-bgbar-track">
              <span className="sv-bgbar-fill" style={{ width: `${src.progress.pct}%` }} />
            </span>
          )}
        </span>
      ))}
    </button>
  );
  // what each background command was started as, from its card — the bar
  // names a job by its command, not by the harness's task id
  const shellCommand = new Map<string, string>();
  for (const it of items) {
    if (it.kind !== 'toolgroup') continue;
    const id = bgIdOf(it.g);
    // claude names each call (Bash `description`); that is the task's name —
    // the command itself is the fallback
    if (id) shellCommand.set(id, it.g.use.label || firstLine(it.g.use.text));
  }
  // A long FOREGROUND Bash is tracked by the harness as a task too, but never
  // announced ("…background with ID"), so nothing names it — the bar showed
  // a bare task id. It is the Bash call still waiting for its result.
  const pendingBash = [...items]
    .reverse()
    .find(
      (it): it is Extract<ConversationItem, { kind: 'toolgroup' }> =>
        it.kind === 'toolgroup' &&
        it.g.use.toolName === 'Bash' &&
        it.g.results.length === 0 &&
        !bgIdOf(it.g),
    );
  // a Monitor is announced its own way and named by the core — lent the
  // pending Bash's name, it would be that command in the bar
  const unannounced = runningShellList.find((sh) => !sh.monitor && !shellCommand.has(sh.id));
  const pendingShell =
    pendingBash && unannounced ? { key: keyOf(pendingBash.g.use), shell: unannounced } : undefined;
  if (pendingBash && unannounced)
    shellCommand.set(unannounced.id, pendingBash.g.use.label || firstLine(pendingBash.g.use.text));

  /* The row under the last answer. "Took … · done at …" is known only to a
     view that watched the turn end — one mounted after it (an app restart, a
     reload, switching back to the session) never sees that edge. The row
     used to hang on it entirely, and with it the only place the model is
     named when idle: after a restart the stream showed no model at all until
     a turn finished in front of it (09-23). What the session IS — its model,
     what it left running — does not depend on having watched. */
  const doneParts: JSX.Element[] = [];
  if (lastDone) {
    doneParts.push(<span key="took">Took {fmtSeconds(lastDone.seconds)}</span>);
    doneParts.push(
      <span key="at">
        done at{' '}
        {new Date(lastDone.at).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })}
      </span>,
    );
  }
  if (runningCommands > 0)
    doneParts.push(
      <span key="bg" className="sv-done-live">
        {runningCommands} background {runningCommands === 1 ? 'command' : 'commands'} still running
      </span>,
    );
  if (knownAgents.size > 0)
    doneParts.push(
      <span key="agents">
        {knownAgents.size} {knownAgents.size === 1 ? 'sub-agent' : 'sub-agents'}
      </span>,
    );
  if (model)
    doneParts.push(
      <span key="model" className="sv-done-model" title={model}>
        {modelShortName(model)}
      </span>,
    );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegates clicks on the links inside; they stay keyboard-reachable as links
    <div
      className="stream-view"
      style={{ display: active ? 'flex' : 'none' }}
      onClick={onLinkClick}
      {...(inDesktopWindow() ? { onContextMenu: onPathMenu } : {})}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(PATH_DRAG_MIME)) e.preventDefault();
      }}
      onDrop={onDropFiles}
    >
      {/* Drilled into a sub-agent. It covers the session rather than replacing
          it, so leaving is one tap and the conversation underneath keeps its
          scroll position — the agent is a branch of this conversation, not a
          different place. */}
      {bgShell && (
        <div className="sv-sub">
          <div className="sv-sub-head">
            <button type="button" className="sv-sub-back" onClick={() => setBgShell(null)}>
              ‹ Back
            </button>
            <span className="sv-sub-task" title={bgOut?.command ?? bgShell.head}>
              {bgOut?.label || plainLine(bgShell.head)}
            </span>
            <span className={`sv-bg-state${bgOut?.done === false ? ' running' : ''}`}>
              {bgOut === null
                ? '…'
                : bgOut.done
                  ? `Finished · code ${bgOut.exitCode ?? '?'}`
                  : 'Running'}
            </span>
          </div>
          {bgOut?.command && (
            // the whole command, wrapped — the header only has room for a name
            <details className="sv-bg-cmd">
              <summary>Command</summary>
              <pre>{bgOut.command}</pre>
            </details>
          )}
          <div className="sv-scroll sv-sub-scroll">
            {bgOut === null ? (
              <div className="sv-empty">
                <span className="wait-row">
                  <FoxWait size={18} /> Reading output…
                </span>
              </div>
            ) : bgOut.text.trim() === '' ? (
              /* A polling loop prints nothing until it finds what it waits for.
                 Say that, rather than showing an empty box that reads as broken. */
              <div className="sv-empty">
                {bgOut.files?.length ? (
                  // a silent download: what it is writing is the only progress there is
                  <div className="sv-bg-files">
                    {bgOut.files.map((f) => (
                      <div key={f.path}>
                        {bgOut.done ? 'Wrote' : 'Writing'} <b>{f.path.split('/').pop()}</b> ·{' '}
                        {fmtBytes(f.bytes)}
                      </div>
                    ))}
                  </div>
                ) : bgOut.done ? (
                  'This command produced no output'
                ) : (
                  "No output yet — the command is running, it just hasn't printed anything"
                )}
              </div>
            ) : (
              <>
                {bgOut.truncated && (
                  <div className="sv-bg-cut">
                    Showing the tail only ({Math.round(bgOut.bytes / 1024)}KB total)
                  </div>
                )}
                <pre className="sv-bg-pre">{bgOut.text}</pre>
              </>
            )}
          </div>
        </div>
      )}
      {subagent && (
        <div className="sv-sub">
          <div className="sv-sub-head">
            <button type="button" className="sv-sub-back" onClick={() => setSubagent(null)}>
              ‹ Back
            </button>
            <span className="sv-sub-task" title={subagent.task}>
              {subagent.task.slice(0, 90)}
            </span>
          </div>
          <div className="sv-scroll sv-sub-scroll">
            {subTurns.length === 0 ? (
              <div className="sv-empty">
                <span className="wait-row">
                  <FoxWait size={18} /> Reading the sub-agent's conversation…
                </span>
              </div>
            ) : (
              (() => {
                const subItems = buildItems(displaySubTurns);
                return renderList(subItems, false);
              })()
            )}
          </div>
          <div className="sv-sub-compose">
            {subNote && <div className="sv-sub-note">{subNote}</div>}
            <textarea
              className="sv-sub-input"
              rows={2}
              value={subText}
              placeholder="Message this sub-agent…"
              onChange={(e) => {
                const composing =
                  Boolean((e.nativeEvent as { isComposing?: boolean }).isComposing) ||
                  ime.isComposing();
                setSubText(composing ? e.target.value : asciiPunctuation(e.target.value));
              }}
              {...ime.imeProps}
              onCompositionEnd={() => {
                ime.imeProps.onCompositionEnd();
                setSubText((d) => asciiPunctuation(d));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !ime.isImeCommit(e)) {
                  e.preventDefault();
                  void sendToSubagent();
                }
              }}
            />
            <button
              type="button"
              className="sv-send"
              disabled={!subText.trim()}
              onClick={() => void sendToSubagent()}
            >
              {IconSend}
            </button>
          </div>
        </div>
      )}
      <div className="sv-scroll" ref={scrollRef} onScroll={onScroll}>
        <div ref={topSentinelRef} className="sv-top-sentinel" />
        {loadingMore && (
          <div className="sv-older wait-row">
            <FoxWait size={16} /> Loading older messages…
          </div>
        )}
        {!loadingMore && olderNote && <div className="sv-older">{olderNote}</div>}
        {!loadingMore && !olderNote && hasMore && !loading && (
          <button type="button" className="sv-older sv-older-btn" onClick={loadOlder}>
            Load older messages
          </button>
        )}
        {loading && (
          <div className="sv-empty">
            <span className="wait-row">
              <FoxWait size={18} /> loading transcript…
            </span>
          </div>
        )}
        {!loading && turns.length === 0 && externalRuns.length === 0 && (
          <div className="sv-empty">no messages yet — say something below</div>
        )}
        {renderList(items, working)}
        {pending
          .filter((m) => !hiddenPending.has(m.id))
          .map((m) => (
            <div key={`p${m.id}`} className="sv-turn sv-user">
              <div className={`sv-bubble sv-bubble-pending${m.stale ? ' stale' : ''}`}>
                {renderUserText(m.text)}
                {providerId === 'codex' && m.queued ? (
                  <span className="sv-pending-stale">awaiting confirmation</span>
                ) : m.stale ? (
                  <span className="sv-pending-stale" title="claude never recorded this message">
                    not delivered
                  </span>
                ) : (
                  <span className="sv-pending-dots">
                    <span />
                    <span />
                    <span />
                  </span>
                )}
              </div>
            </div>
          ))}
        {!working && doneParts.length > 0 && (
          <div className="sv-done">
            {doneParts.map((part, i) => (
              <Fragment key={part.key}>
                {i > 0 && <span className="sv-done-sep">·</span>}
                {part}
              </Fragment>
            ))}
          </div>
        )}
        {working && (
          <div className="sv-working">
            <span className="sv-working-row">
              <FoxWait />
              <span className="sv-working-dot" />
              <span className="sv-working-dot" />
              <span className="sv-working-dot" />
              <span className="sv-working-meta">
                {turnStartMs > 0 && fmtElapsed}
                {turnTokens > 0 && ` · ↓ ${fmtTokens} tokens`}
                {model && ` · ${modelShortName(model)}`}
              </span>
            </span>
            {/* held back for the first few seconds: a quick answer shouldn't
                flash a tip on its way past. The key remounts the node so each
                new line fades in instead of swapping in place. */}
            {busyStatusLine ? (
              <span
                className={
                  COMPACTING_RE.test(busyStatusLine) ? 'sv-working-status' : 'sv-working-retry'
                }
              >
                {busyStatusLine}
              </span>
            ) : (
              elapsedS >= 6 && (
                <span className="sv-working-tip" key={foxLine}>
                  {FOX_LINES[foxLine]}
                </span>
              )
            )}
          </div>
        )}
        {(providerId === 'codex' ? codexQueue.length : tray.length) > 0 && (
          <div className="sv-queue">
            <div className="sv-queue-head">
              Queued · {providerId === 'codex' ? codexQueue.length : tray.length} —{' '}
              {providerId === 'codex'
                ? 'submitted after the next tool call'
                : 'handled in order after this turn'}
            </div>
            {providerId === 'codex'
              ? codexQueue.map((text, index) => (
                  <div key={`q${sessionId}:${index}:${text}`} className="sv-turn sv-user">
                    <div className="sv-bubble sv-bubble-queued">{renderUserText(text)}</div>
                  </div>
                ))
              : tray.map((t) => (
                  <div key={`q${keyOf(t)}`} className="sv-turn sv-user" title={timeOf(t)}>
                    <div className="sv-bubble sv-bubble-queued">{renderUserText(t.text)}</div>
                  </div>
                ))}
          </div>
        )}
      </div>
      {viewer && shown && (
        <div
          className="sv-viewer"
          onClick={() => {
            zoomReset();
            setViewer(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setViewer(null);
          }}
        >
          <div
            className="sv-viewer-stage"
            ref={viewerStageRef}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onPointerDown={onZoomDown}
            onPointerMove={onZoomMove}
            onPointerUp={onZoomUp}
            onPointerCancel={onZoomUp}
            onDoubleClick={() =>
              setZoom((z) => (z.k === 1 ? { k: 2.5, x: 0, y: 0 } : { k: 1, x: 0, y: 0 }))
            }
          >
            <img
              src={shownSrc}
              alt={shown.name}
              draggable={false}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                if (w && h) setViewerNatural({ w, h });
              }}
              style={{
                transform: `translate(${zoom.x + swipe.dx}px, ${zoom.y}px)`,
                // no transition while a finger is on it — the picture must sit
                // exactly under the finger, not chase it
                transition: swipe.animating ? 'transform 170ms ease-out' : 'none',
                cursor: zoom.k > 1 ? 'grab' : 'zoom-in',
                ...(viewerBox
                  ? {
                      width: viewerBox.width,
                      height: viewerBox.height,
                      maxWidth: 'none',
                      maxHeight: 'none',
                    }
                  : {}),
              }}
            />
          </div>
          <button
            type="button"
            className="sv-viewer-x"
            onClick={() => {
              zoomReset();
              setViewer(null);
            }}
          >
            ×
          </button>
          {viewer.items.length > 1 && (
            <>
              {/* which of how many — without it a flick that lands on a
                  similar picture looks like nothing happened */}
              <div className="sv-viewer-n">
                {viewer.i + 1} / {viewer.items.length}
              </div>
              {/* arrows for pointing devices only: a phone has the flick, and
                  these would just sit on top of the picture */}
              <button
                type="button"
                className="sv-viewer-nav sv-viewer-prev"
                disabled={viewer.i === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  go(-1);
                }}
              >
                ‹
              </button>
              <button
                type="button"
                className="sv-viewer-nav sv-viewer-next"
                disabled={viewer.i === viewer.items.length - 1}
                onClick={(e) => {
                  e.stopPropagation();
                  go(1);
                }}
              >
                ›
              </button>
            </>
          )}
        </div>
      )}
      {(unseen > 0 || !atBottom) && (
        <button type="button" className="sv-jump" onClick={jumpToBottom}>
          {unseen > 0 ? `${unseen} new ${unseen === 1 ? 'message' : 'messages'}` : 'Jump to end'}
          <span className="sv-jump-ic">{IconDown}</span>
        </button>
      )}
      {(awaitingSubmit || reviewSubmitStatus) && (
        <div className="sv-review-submit" role="status">
          {awaitingSubmit && (
            <>
              <span>Ready to submit your answers?</span>
              <button
                type="button"
                className="sv-ask-confirm"
                disabled={reviewSubmitting}
                onClick={submitReviewAnswers}
              >
                {reviewSubmitting ? 'Submitting…' : 'Submit answers'}
              </button>
            </>
          )}
          {reviewSubmitStatus && <small>{reviewSubmitStatus}</small>}
        </div>
      )}
      {picker && !awaitingSubmit && !((quickModelOpen || switchingModel) && isModelPicker(picker)) && (
        <div className="sv-picker">
          {picker.title && <div className="sv-picker-title">{picker.title}</div>}
          {picker.options.map((o) =>
            o === textRow && pickerText !== null ? (
              // the TUI's own text field, answered from here: focus it with
              // the arrows, clear what is there, type, then Enter
              <form
                key={o.n}
                className="sv-picker-type"
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = pickerText.trim();
                  if (!text) return;
                  sendSeq(`${keysToReach(picker, o)}${'\x7f'.repeat(typedIn(o).length)}${text}`);
                  // a multi-select ticks the row as it is typed into, and Enter would
                  // untick it again — the question is finished from Next instead
                  if (!picker.multi) setTimeout(() => sendSeq('\r'), 150);
                  setPickerText(null);
                }}
              >
                <input
                  // biome-ignore lint/a11y/noAutofocus: the user just chose to type
                  autoFocus
                  value={pickerText}
                  placeholder="Type your answer…"
                  onChange={(e) => setPickerText(e.target.value)}
                  {...ime.imeProps}
                  onKeyDown={(e) => {
                    // the Enter that commits a Chinese candidate is not a send
                    if (e.key === 'Enter' && ime.isImeCommit(e)) e.preventDefault();
                  }}
                />
                <button type="submit" disabled={!pickerText.trim()}>
                  {picker.multi ? 'Add' : 'Send'}
                </button>
              </form>
            ) : (
              <button
                type="button"
                key={o.n}
                className={`sv-ask-opt${(picker.multi ? o.checked : o.selected) ? ' picked' : ''}`}
                onClick={() => {
                  // a digit on the text row types that digit into it — move
                  // there with the arrows and answer from our own field
                  if (o === textRow) {
                    sendSeq(keysToReach(picker, o));
                    setPickerText(typedIn(o));
                    return;
                  }
                  if (isModelPicker(picker)) {
                    // Digits also confirm model choices and can change Claude's
                    // global default. Manual menus navigate, then confirm below.
                    const current = parsePicker(readScreen(sessionId));
                    if (!current || current.title !== picker.title || !isModelPicker(current))
                      return;
                    const option = current.options.find(
                      (item) => item.n === o.n && item.label === o.label,
                    );
                    if (option) sendSeq(keysToReach(current, option));
                    return;
                  }
                  if (picker.numbered === false) {
                    // no numbers drawn, so a digit does nothing: walk the
                    // highlight there from where the screen has it now
                    const current = parsePicker(readScreen(sessionId));
                    const option = current?.options.find((item) => item.label === o.label);
                    if (current?.numbered === false && option) {
                      // Cursor AskQuestion toggles with Space; Enter would
                      // advance/submit the whole form instead.
                      const key = isSpaceToggleMulti(current) ? ' ' : '\r';
                      sendSeq(`${keysToReach(current, option)}${key}`);
                    }
                    return;
                  }
                  // with the cursor inside the text field a digit is typed into it
                  // ("2222…"), so leave it with the arrows and press Enter instead
                  const live = parsePicker(readScreen(sessionId));
                  const liveText = live ? freeTextOption(live) : undefined;
                  if (live && liveText?.selected) {
                    const option = live.options.find((item) => item.label === o.label);
                    if (option) sendSeq(`${keysToReach(live, option)}\r`);
                    return;
                  }
                  sendSeq(String(o.n));
                }}
              >
                <span className="sv-ask-opt-label">
                  {o.checked !== undefined && (
                    <span className={`sv-ask-box${o.checked ? ' on' : ''}`} aria-hidden="true" />
                  )}
                  {o === textRow && !typedIn(o) ? 'Type your own answer…' : o.label}
                </span>
                {o.description && <span className="sv-ask-opt-desc">{o.description}</span>}
              </button>
            ),
          )}
          {picker.multi && (
            <button
              type="button"
              className="sv-ask-confirm"
              onClick={() => {
                const current = parsePicker(readScreen(sessionId));
                if (!current?.multi) return;
                // Cursor AskQuestion: Enter next/submit (no separate Next row).
                if (isSpaceToggleMulti(current)) {
                  sendSeq('\r');
                  return;
                }
                // Claude: Next is a row of its own, reached with the arrows.
                sendSeq(`${keysToNext(current)}\r`);
              }}
            >
              {isSpaceToggleMulti(picker) ? 'Submit' : 'Next'}
            </button>
          )}
          <div className="sv-picker-foot">
            <span>{picker.hint}</span>
            {isModelPicker(picker) && (
              <button
                type="button"
                className="sv-picker-esc"
                onClick={() => {
                  const current = parsePicker(readScreen(sessionId));
                  if (current?.title === picker.title && isModelPicker(current))
                    sendSeq(/\bs\b.*session/i.test(current?.hint ?? '') ? 's' : '\r');
                }}
              >
                Confirm
              </button>
            )}
            {!isModelPicker(picker) && /\bs session\b/.test(picker.hint) && (
              <button
                type="button"
                className="sv-picker-esc"
                title="Use the highlighted reasoning level for this session only"
                onClick={() => sendSeq('s')}
              >
                Session only
              </button>
            )}
            <button type="button" className="sv-picker-esc" onClick={() => sendSeq('\x1b')}>
              {/\besc back\b/.test(picker.hint) ? 'Back' : 'Cancel'}
            </button>
          </div>
        </div>
      )}
      {sendErr && <div className="sv-send-err">{sendErr}</div>}
      {menu && (
        <PathContextMenu
          rpc={rpc}
          menu={menu}
          onClose={closeMenu}
          onOpen={(abs) => onOpenPath?.(abs, cwd)}
          // 'path copied' is a receipt, not a failure — it should not sit
          // there like the send errors this line usually carries
          onNote={(t) => {
            setSendErr(t);
            window.setTimeout(() => setSendErr((cur) => (cur === t ? '' : cur)), 2000);
          }}
        />
      )}
      {atAtOpen && (
        <div className="sv-slash" role="listbox" aria-label="Mention teammate">
          {atAtHits.length === 0 ? (
            <div className="sv-slash-item muted">
              No teammates in this project or Chats
            </div>
          ) : (
            atAtHits.map((h, i) => (
              <button
                type="button"
                key={h.sessionId}
                role="option"
                aria-selected={i === atAtIndex}
                className={`sv-slash-item${i === atAtIndex ? ' on' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickHumanMention(h)}
              >
                <span className="sv-slash-name">@@{h.name}</span>
                <span className="sv-slash-desc">{h.detail}</span>
              </button>
            ))
          )}
        </div>
      )}
      {atOpen && (
        <div className="sv-slash" role="listbox">
          {atHits.map((p, i) => (
            <button
              type="button"
              key={p}
              role="option"
              aria-selected={i === atIndex}
              className={`sv-slash-item${i === atIndex ? ' on' : ''}`}
              onMouseDown={(e) => e.preventDefault()} // keep the caret in the box
              onClick={() => pickMention(p)}
            >
              <span className="sv-slash-name">@{p}</span>
            </button>
          ))}
        </div>
      )}
      {slashMatches.length > 0 && (
        <div className="sv-slash" role="listbox" aria-label="Slash commands" ref={slashMenuRef}>
          {slashMatches.map((c, index) => (
            <button
              type="button"
              key={c.name}
              role="option"
              aria-selected={index === selectedSlash}
              data-slash-index={index}
              className={`sv-slash-item${index === selectedSlash ? ' on' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setDraft(`/${c.name} `);
                taRef.current?.focus();
              }}
            >
              <span className="sv-slash-name">/{c.name}</span>
              {c.description && <span className="sv-slash-desc">{c.description}</span>}
              {c.source !== 'builtin' && <span className="sv-slash-src">{c.source}</span>}
            </button>
          ))}
        </div>
      )}
      {runningShells + runningAgents.length > 0 && (
        <div className="sv-bgbar">
          {/* a docked panel with its own header — as plain cards it read as
              more messages at the end of the chat */}
          <div className="sv-bgbar-head">
            <span>Background tasks</span>
            <span className="sv-bgbar-head-n">{runningShells + runningAgents.length}</span>
          </div>
          {runningAgents.map((a) => (
            <Fragment key={a.agentId}>
              <button
                type="button"
                className="sv-bgbar-item"
                title="Open this sub-agent's conversation"
                onClick={() => {
                  setSubTurns([]);
                  setSubNote('');
                  setSubagent({ agentId: a.agentId, task: a.task });
                }}
              >
                <span className="sv-bgbar-top">
                  <span className="sv-bgbar-dot" />
                  <span className="sv-bgbar-kind">Agent</span>
                  <span className="sv-bgbar-cmd">{a.label || a.task || a.agentId}</span>
                  {/* what it is doing sits beside its name (hidden on a phone,
                    where the width is the name's); under that, in small type,
                    each command or watcher it left running — in its own row,
                    not rows of their own */}
                  {(a.activity || shellsByAgent.has(a.agentId)) && (
                    <span className="sv-bgbar-mid">
                      {a.activity && <span className="sv-bgbar-line">{plainLine(a.activity)}</span>}
                      {(shellsByAgent.get(a.agentId) ?? []).map((sh) => childLines(sh))}
                    </span>
                  )}
                  {/* running time, then how big its conversation has grown */}
                  <span className="sv-bgbar-num">{sinceText(a.startedAt)}</span>
                  {a.tokens ? (
                    <span className="sv-bgbar-tok" title="Tokens in its latest reply">
                      {a.tokens >= 1e6
                        ? `${(a.tokens / 1e6).toFixed(1)}M`
                        : a.tokens >= 1e3
                          ? `${(a.tokens / 1e3).toFixed(1)}k`
                          : a.tokens}{' '}
                      tok
                    </span>
                  ) : null}
                </span>
              </button>
            </Fragment>
          ))}
          {runningShellList
            .filter((sh) => !sh.agentId || !runningAgentIds.has(sh.agentId))
            .map((sh) => shellRow(sh))}
        </div>
      )}
      <div className="sv-composer">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => void onFile(e)}
        />
        {attachments.length > 0 && (
          <div className="sv-att-row">
            {attachments.map((a) => (
              <div key={a.path} className="sv-att">
                {a.url ? (
                  <img src={a.url} alt={a.path.split('/').pop() ?? ''} />
                ) : (
                  <span className="sv-att-name">{a.path.split('/').pop()}</span>
                )}
                {a.uploading && (
                  <span className="sv-att-busy">
                    <FoxWait size={16} />
                  </span>
                )}
                <button
                  type="button"
                  className="sv-att-x"
                  onClick={() => setAttachments((x) => x.filter((v) => v.path !== a.path))}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="sv-composer-row">
          <button
            type="button"
            className="sv-plus"
            onClick={() => fileRef.current?.click()}
            title="Attach image"
          >
            {IconPlus}
          </button>
          <textarea
            ref={taRef}
            onFocus={() => {
              // the keyboard may already be up (no viewport resize fires)
              const el = scrollRef.current;
              if (!el) return;
              setTimeout(() => {
                el.scrollTop = el.scrollHeight;
                nearBottomRef.current = true;
                setAtBottom(true);
                setUnseen(0);
              }, 300);
            }}
            className="sv-input"
            rows={1}
            onPaste={onPaste}
            disabled={pendingHandoff}
            placeholder={pendingHandoff ? 'Handing off…' : 'Message…'}
            value={draft}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onChange={(e) => {
              const el = e.target;
              // Always rewrite marks (including （）) as they land. Waiting
              // until send — or skipping while an IME flag was sticky — left
              // fullwidth parens visible in the box. Pinyin composition is
              // ASCII letters; converting marks does not disturb it.
              const raw = el.value;
              const start = el.selectionStart ?? raw.length;
              const { text, caret } = asciiPunctuationAt(raw, start);
              setDraft(text);
              setSlashIndex(0);
              setSlashDismissed(false);
              setCaret(caret);
              collapseAll(); // typing means reading is over
              // grow with content up to the CSS max-height — a one-row box
              // clipped its own second line (and even the placeholder)
              el.style.height = 'auto';
              el.style.height = `${el.scrollHeight}px`;
              if (text !== raw) {
                requestAnimationFrame(() => {
                  try {
                    el.setSelectionRange(caret, caret);
                  } catch {
                    /* unmounted */
                  }
                });
              }
            }}
            onBlur={() => setDraft((d) => asciiPunctuation(d))}
            {...ime.imeProps}
            onCompositionEnd={() => {
              ime.imeProps.onCompositionEnd();
              setDraft((d) => asciiPunctuation(d));
            }}
            onKeyDown={(e) => {
              if (slashOpen && !e.shiftKey && !ime.isImeCommit(e)) {
                const action = slashKeyAction(e.key, draft, slashMatches, selectedSlash);
                if (action) {
                  e.preventDefault();
                  if (action.kind === 'select') setSlashIndex(action.index);
                  else if (action.kind === 'complete') setDraft(action.text);
                  else setSlashDismissed(true);
                  return;
                }
              }
              if (atAtOpen && !e.nativeEvent.isComposing) {
                const n = atAtHits.length;
                if (n > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault();
                  setAtAtIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
                  return;
                }
                if (n > 0 && ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab')) {
                  e.preventDefault();
                  const hit = atAtHits[Math.min(atAtIndex, n - 1)];
                  if (hit) pickHumanMention(hit);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setAtAtDismissed(atAtTok?.start ?? null);
                  return;
                }
              }
              if (atOpen && !e.nativeEvent.isComposing) {
                const n = atHits.length;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  setAtIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
                  return;
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  e.preventDefault();
                  const path = atHits[Math.min(atIndex, n - 1)];
                  if (path) pickMention(path);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setAtDismissed(atTok?.start ?? null);
                  return;
                }
              }
              if (e.key === 'ArrowUp' && pullQueued(e.currentTarget)) {
                e.preventDefault();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !ime.isImeCommit(e)) {
                e.preventDefault();
                send();
              }
            }}
          />
          {working && !draft.trim() && attachments.length === 0 ? (
            <button
              type="button"
              className="sv-send sv-stop"
              onClick={() => sendSeq('\x1b')}
              title="Stop generating"
            >
              {IconStop}
            </button>
          ) : (
            <button
              type="button"
              className="sv-send"
              onClick={send}
              disabled={
                pendingHandoff ||
                quickModelOpen ||
                (!!picker && !(switchingModel && isModelPicker(picker))) ||
                (!draft.trim() && attachments.length === 0)
              }
            >
              {IconSend}
            </button>
          )}
        </div>
        {active && (providerId === 'claude' || providerId === 'codex' || !providerId) && (
          <div className="sv-model-toolbar">
            <StreamModelPicker
              key={`${sessionId}:${providerId}`}
              rpc={rpc}
              sessionId={sessionId}
              providerId={providerId ?? 'claude'}
              label={model ? modelShortName(model) : 'Select model'}
              pendingModel={pendingModel}
              onChoose={chooseModel}
              disabled={!active || !!pendingHandoff || switchingModel}
              onOpenChange={setQuickModelOpen}
              onUserInput={onUserInput}
            />
          </div>
        )}
      </div>
      {pendingHandoff && (
        <div className="term-handoff-overlay">
          <div className="term-handoff-card">
            <div className="term-handoff-spin" />
            <div className="term-handoff-title">Handoff in progress</div>
            <div className="term-handoff-sub">
              {humanName || 'This session'} is writing the handoff document.
              <br />
              The successor session will open here automatically.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AskOption {
  label: string;
  description?: string;
}
interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

/** Claude's AskUserQuestion rendered as REAL options. A tap sends the
 *  option's digit — verified against the TUI: a single digit answers a
 *  single-select picker immediately; for multiSelect digits toggle and the
 *  question's Next row (not Enter on an option, which ticks it) moves on. Interactive only while the picker is plausibly still up
 *  (last card, no result yet); once the tool_result lands the card shows
 *  the given answer instead. */
function QuestionCard({
  questions,
  answerText,
  answers,
  active,
  awaitingSubmit,
  sendKey,
  sendNext,
}: {
  questions: AskQuestion[];
  answerText: string;
  /** the answer cut per question (see askAnswers.ts); absent = show answerText whole */
  answers?: string[];
  active: boolean;
  /** the terminal is showing the review screen — answered here or elsewhere */
  awaitingSubmit?: boolean;
  sendKey: (seq: string) => void;
  /** leave a multi-select question for the next one */
  sendNext: () => void;
}): JSX.Element {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [confirmed, setConfirmed] = useState<Set<number>>(() => new Set());
  const [submitted, setSubmitted] = useState(false);
  // Several questions end on claude's own "Review your answers → Submit
  // answers" screen. The picker overlay reads it off the terminal, but a
  // screen read can miss (a frame drawn for another width comes back
  // scrambled) and the user then waits on a prompt they cannot see. So the
  // card offers the submit itself once every question has its answer —
  // Enter, because Submit is the row the review screen highlights.
  const answeredAll = questions.every((q, qi) =>
    q.multiSelect ? confirmed.has(qi) : [...picked].some((k) => k.startsWith(`${qi}:`)),
  );
  return (
    <div className="sv-ask">
      {questions.map((q, qi) => (
        <div key={`${q.question}-${qi}`} className="sv-ask-q">
          <div className="sv-ask-title">
            {q.header && <span className="sv-ask-header">{q.header}</span>}
            {q.question}
          </div>
          {answerText ? (
            <div className="sv-ask-answered">{answers?.[qi] ?? answerText}</div>
          ) : (
            <>
              {q.options.map((o, oi) => {
                const k = `${qi}:${oi}`;
                return (
                  <button
                    type="button"
                    key={k}
                    className={`sv-ask-opt${picked.has(k) ? ' picked' : ''}`}
                    disabled={!active || (!q.multiSelect && hasAnswerForQuestion(picked, qi) && !picked.has(k))}
                    onClick={() => {
                      if (!active) return;
                      sendKey(String(oi + 1));
                      setPicked((prev) => {
                        const n = new Set(prev);
                        if (q.multiSelect && n.has(k)) n.delete(k);
                        else n.add(k);
                        return n;
                      });
                    }}
                  >
                    <span className="sv-ask-opt-label">{o.label}</span>
                    {o.description && <span className="sv-ask-opt-desc">{o.description}</span>}
                  </button>
                );
              })}
              {q.multiSelect && active && (
                <button
                  type="button"
                  className="sv-ask-confirm"
                  disabled={!hasAnswerForQuestion(picked, qi)}
                  onClick={() => {
                    sendNext();
                    setConfirmed((prev) => new Set(prev).add(qi));
                  }}
                >
                  Confirm
                </button>
              )}
            </>
          )}
        </div>
      ))}
      {active && !answerText && questions.length > 1 && answeredAll && !awaitingSubmit && (
        <button
          type="button"
          className="sv-ask-confirm"
          disabled={submitted}
          onClick={() => {
            sendKey('\r');
            setSubmitted(true);
          }}
        >
          {submitted ? 'Submitted…' : 'Submit answers'}
        </button>
      )}
    </div>
  );
}

/** Photos attached on THIS device render straight from the picked file —
 *  no reason to round-trip the bytes we are still holding. path → objectURL,
 *  capped; anything not here (other devices, history) falls back to RPC. */
/** "claude-fable-5-1" reads as "fable 5.1" — the family and version, which is
 *  what a person checks for. An id we do not recognise is shown as it is. */
export function modelShortName(id: string): string {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(id);
  if (!m) return id.replace(/^claude-/, '');
  const [, family, major, minor] = m;
  return `${(family ?? '').toLowerCase()} ${major}${minor ? `.${minor}` : ''}`;
}

/** 24s · 3m20s · 1h04m — the terminal's own shape for a turn's length. */
function fmtSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** longest edge of an inline picture's scaled copy — a bubble is at most a
 *  few hundred CSS px wide, doubled for retina */
/** queued records claude injected rather than the person typing them */
const MACHINE_QUEUED_RE =
  /^\s*(?:<(?:task-notification|system-reminder|agent-message|cross-session-message|local-command|command-name|user-prompt-submit-hook)\b|\[Ateam\b)/i;
const THUMB_EDGE = 720;
/** dropped files shown as pictures rather than pasted as a path */
const DROP_IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|heic|avif|tiff?)$/i;
/** width asked for when the original itself is too big to send */
const FULL_EDGE = 4096;
/** originals fetched for the viewer, by path; a handful, oldest dropped */
const fullOriginals = new Map<string, string>();
function rememberOriginal(path: string, url: string): void {
  if (fullOriginals.size >= 12) {
    const oldest = fullOriginals.keys().next().value;
    if (oldest !== undefined) {
      const old = fullOriginals.get(oldest);
      if (old) URL.revokeObjectURL(old);
      fullOriginals.delete(oldest);
    }
  }
  fullOriginals.set(path, url);
}

const localThumbs = new Map<string, string>();
export function rememberLocalThumb(path: string, file: Blob): void {
  if (localThumbs.size >= 20) {
    const oldest = localThumbs.keys().next().value;
    if (oldest !== undefined) {
      const url = localThumbs.get(oldest);
      if (url) URL.revokeObjectURL(url);
      localThumbs.delete(oldest);
    }
  }
  localThumbs.set(path, URL.createObjectURL(file));
}

/** The photo the user sent, shown AS a photo. Falls back to a name chip
 *  while loading or when the file is gone (uploads can be cleaned up). */
function UploadThumb({
  rpc,
  path,
  onOpen,
  chipWhenMissing = true,
}: {
  rpc: Rpc;
  path: string;
  onOpen?: (v: { src: string; name: string }) => void;
  /** false: render nothing when the path is not a readable image (a path
   *  mentioned in prose may not exist — no chip, no noise) */
  chipWhenMissing?: boolean;
}): JSX.Element | null {
  const [src, setSrc] = useState(() => localThumbs.get(path) ?? '');
  // set when what shows is a scaled copy: the viewer fetches the original
  const [scaled, setScaled] = useState(false);
  const [missing, setMissing] = useState(false);
  // bumped when a shown picture fails to load — read the file again
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` only re-runs the read
  useEffect(() => {
    if (localThumbs.has(path)) return;
    let alive = true;
    let url = '';
    // a scaled copy — a few hundred KB instead of a screenshot's megabytes;
    // an older core without file.thumb gets the plain read
    void rpc
      .request('file.thumb', { path, max: THUMB_EDGE })
      .catch(() => rpc.request('file.read', { path }))
      .then((r) => {
        if (!alive) return;
        if (r.kind === 'image' && r.base64) {
          // a blob, never a data: URL — see imageBlob.ts
          url = imageObjectUrl(r.base64, r.mime);
          setScaled('thumb' in r && r.thumb === true);
          setSrc(url);
        } else setMissing(true);
      })
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [rpc, path, reload]);
  const name = path.split('/').pop() ?? 'image';
  if (!src) {
    if (missing && !chipWhenMissing) return null;
    if (!chipWhenMissing) return null;
    return (
      <span className="sv-img-chip" title={path}>
        {IconImage} {name}
      </span>
    );
  }
  return (
    <img
      className="sv-img-thumb"
      src={src}
      alt={name}
      data-full={scaled ? path : undefined}
      // A picture that WAS showing can stop loading while the file is fine on
      // disk: the local preview of a pasted image points at WebKit's copy of
      // the clipboard, which does not outlive the paste for long; a reconnect
      // revokes the old blob before the new read lands. Either way the answer
      // is the file itself — read it again (twice at most, then a chip).
      onError={() => {
        if (localThumbs.get(path) === src) localThumbs.delete(path);
        setSrc('');
        if (reload < 2) setReload(reload + 1);
        else setMissing(true);
      }}
      onClick={() => onOpen?.({ src, name })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen?.({ src, name });
      }}
    />
  );
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};
const decodeEntities = (v: string): string =>
  v.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m);

/** A shell one-liner is not a label. Keep the part that says what ran: the
 *  last &&-segment, minus redirections, with long paths reduced to their
 *  basename. "cd /Users/…/apps/desktop && export PATH=… && pnpm exec tauri
 *  build 2>&1 | tail -4" → "pnpm exec tauri build". */
export function shortenCommand(raw: string): string {
  let cmd = decodeEntities(raw).replace(/\s+/g, ' ').trim();
  const segments = cmd
    .split('&&')
    .map((v) => v.trim())
    .filter((v) => v && !/^(cd|export|source|\.)\b/.test(v));
  if (segments.length > 0) cmd = segments[segments.length - 1] ?? cmd;
  cmd = cmd
    .replace(/\s*\|\s*(tail|head|grep|awk|sed|cat)\b.*$/, '')
    .replace(/\s*\d?>[&]?\S+/g, '')
    .replace(/(\S*\/)([^/\s]+)/g, (_m, _dir: string, base: string) => base)
    .trim();
  return cmd.length > 48 ? `${cmd.slice(0, 48)}…` : cmd;
}

const tag = (text: string, name: string): string | undefined =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();

/** Machine-injected records are plumbing, not conversation. Turn each into
 *  ONE readable line — or null to drop it. (Stripping every tag and keeping
 *  what is left just printed raw ids: "be16ulzlu toolu_011Gc9… /private/tmp/…")
 */
/**
 * A sub-agent's final report, handed back into the parent conversation by the
 * harness as a "user" record:
 *
 *   <agent-message from="a4ac86162051d4d0f">
 *   [Subagent hand-back] The text below is … The report follows:
 *     <the report, every line indented two spaces>
 *   </agent-message>
 *
 * (as a record it is led by "Another Claude session sent a message:" and
 * followed by a warning paragraph). It is model output, not something the person typed — it must not render as
 * their bubble. Returns the agent id and the report (indent removed).
 */
export function agentMessage(text: string): { from: string; report: string } | null {
  // the record may open with a one-line lead-in ("Another Claude session sent
  // a message:") and close with a warning paragraph after the tag
  const m =
    /^\s*(?:[^\n<]{0,160}\n)?<agent-message\s+from="([^"]*)"\s*>([\s\S]*?)(?:<\/agent-message>[\s\S]*)?$/.exec(
      text,
    );
  if (!m) return null;
  let body = m[2] ?? '';
  const follows = body.indexOf('The report follows:');
  if (follows >= 0) body = body.slice(follows + 'The report follows:'.length);
  const report = body
    .split('\n')
    .map((l) => l.replace(/^ {2}/, ''))
    .join('\n')
    .trim();
  return { from: m[1] ?? '', report };
}

/**
 * A message another SESSION sent this one (Ateam's own relay, and claude's
 * cross-session sockets):
 *
 *   Another Claude session sent a message: <cross-session-message
 *     from="uds:/tmp/cc-socks/39924.sock" from-name="全流程整改"
 *     from-mode="prompting">…</cross-session-message>
 *
 * Like a sub-agent's hand-back it is not the person's words, and the raw tag
 * filled a bubble with plumbing. Returns who sent it and what they said.
 */
export function crossSessionMessage(text: string): { from: string; body: string } | null {
  const m =
    /^\s*(?:[^\n<]{0,160}\n?)??<cross-session-message\s+([^>]*)>([\s\S]*?)(?:<\/cross-session-message>[\s\S]*)?$/.exec(
      text,
    );
  if (!m) return null;
  const attrs = m[1] ?? '';
  const name = /from-name="([^"]*)"/.exec(attrs)?.[1];
  const from = /from="([^"]*)"/.exec(attrs)?.[1] ?? '';
  return { from: name || from.replace(/^uds:/, ''), body: (m[2] ?? '').trim() };
}

/** The change an Edit/Write made, drawn the way the terminal draws it:
 *  numbered lines, additions green, removals red, context dim. One block per
 *  file, since one bash command can edit several. */
export function DiffView({
  patch,
  onOpenFile,
}: {
  patch: NonNullable<Turn['patch']>;
  onOpenFile?: (file: string) => void;
}): JSX.Element {
  return (
    <div className="sv-diff">
      {patch.map((fp, fi) => {
        const lines = fp.hunks.flatMap((hunk) => hunk.lines);
        const added = lines.filter((line) => line.startsWith('+')).length;
        const removed = lines.filter((line) => line.startsWith('-')).length;
        const counts = ` (+${added} -${removed}${fp.dropped ? ', partial' : ''})`;
        return (
          <div className="sv-diff-of-file" key={`${fp.file}-${fi}`}>
            {fp.file &&
              (onOpenFile ? (
                <button
                  type="button"
                  className="sv-diff-file link"
                  onClick={() => onOpenFile(fp.file)}
                >
                  {fp.file}
                  {counts}
                </button>
              ) : (
                <div className="sv-diff-file">
                  {fp.file}
                  {counts}
                </div>
              ))}
            {fp.hunks.map((h, hi) => {
              let oldNo = h.oldStart;
              let newNo = h.newStart;
              return (
                <div className="sv-diff-hunk" key={`${h.oldStart}-${h.newStart}-${hi}`}>
                  {h.lines.map((line, li) => {
                    const sign = line[0] ?? ' ';
                    const no = sign === '-' ? oldNo++ : sign === '+' ? newNo++ : (oldNo++, newNo++);
                    const cls = sign === '+' ? ' add' : sign === '-' ? ' del' : '';
                    return (
                      <div className={`sv-diff-line${cls}`} key={`${hi}-${li}`}>
                        <span className="sv-diff-no">{no}</span>
                        <span className="sv-diff-sign">{sign === ' ' ? '' : sign}</span>
                        <span className="sv-diff-text">{line.slice(1)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {fp.dropped ? <div className="sv-diff-more">… +{fp.dropped} more lines</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/** fallback when the sender is not a session in this cockpit: a stable face
 *  per name, so the same sender always wears the same one */
export function avatarFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 100_000;
  return AVATAR_IDS[h % AVATAR_IDS.length] as string;
}

/** A one-line form of text the harness injected: a sentence to show, `''`
 *  for plumbing with nothing worth showing, `null` when this is not a shape
 *  we know (the caller decides — a record the harness itself labelled is
 *  still worth a line). */
export function machineLine(text: string): string | null {
  const t = text.trimStart();
  // A loaded skill's SKILL.md body is injected as a "user" record — the
  // person did not type a page of instructions at you.
  const skill = /^Base directory for this skill:\s*(\S+)/.exec(t);
  if (skill) {
    const dir = (skill[1] ?? '').replace(/\/+$/, '');
    return `Skill loaded · ${dir.split('/').pop() || dir}`;
  }
  // /context's report, likewise injected
  if (/^##\s*Context Usage/.test(t)) {
    const tokens = /\*\*Tokens:\*\*\s*([^\n]+)/.exec(text)?.[1]?.trim();
    return tokens ? `Context usage · ${tokens}` : 'Context usage';
  }
  // Ateam's own messages to the session — the experience checkpoint, the
  // hand-off request — go in as a paste, so they are recorded as the person's
  // words. Name them instead.
  const ateam = /^\[Ateam[\s—-]+([^\]\n]+)\]/.exec(t);
  if (ateam) {
    const what = (ateam[1] ?? '').trim();
    return /checkpoint/i.test(what)
      ? 'Experience checkpoint · saving what it has learned'
      : /hand-?off/i.test(what)
        ? 'Hand-off · saving what it has learned, then writing the hand-off'
        : `Ateam · ${what}`;
  }
  // the harness telling the model its own turn was cut — emphatically not
  // the person talking, and it landed in their bubble (09-22)
  if (/^Your response above was stopped by a safety classifier/.test(t))
    return 'Response stopped by a safety classifier';
  if (t.startsWith('<system-reminder') || t.startsWith('<local-command-caveat')) return '';
  if (t.startsWith('<task-notification')) {
    // the <summary> is the human sentence; ids and paths are for the agent
    const summary = tag(text, 'summary');
    const status = tag(text, 'status');
    if (summary) {
      // "Background command \"…\" completed (exit code 0)" — the useful
      // bits are WHAT ran and HOW it ended, not the full shell line
      const m = /^Background command "([\s\S]*)" (\w+)(?: \(exit code (\d+)\))?/.exec(
        decodeEntities(summary).replace(/\s+/g, ' ').trim(),
      );
      if (m) {
        const label = shortenCommand(m[1] ?? '');
        const code = m[3];
        const ending =
          code === undefined ? (m[2] ?? '') : code === '0' ? 'done' : `failed · exit ${code}`;
        return `Background task · ${label} · ${ending}`;
      }
      return `Background task · ${decodeEntities(summary).replace(/\s+/g, ' ')}`;
    }
    return `Background task · ${status ?? 'updated'}`;
  }
  if (t.startsWith('<command-name') || t.startsWith('<local-command')) {
    const name = tag(text, 'command-name');
    const out = tag(text, 'local-command-stdout');
    if (name && out) return `${name} · ${decodeEntities(out).replace(/\s+/g, ' ')}`;
    if (name) return name;
    if (out) return decodeEntities(out).replace(/\s+/g, ' ');
    return '';
  }
  return null;
}

function fmtBytes(n: number): string {
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** "2310/6040 · 38% · 13:32<22:10 · 2.8 it/s", "73.5%", or '' — a background
 *  command's progress, timed the way tqdm times it */
function progressText(p: BgShellDTO['progress']): string {
  if (!p) return '';
  const pct = p.pct !== undefined ? `${Math.round(p.pct)}%` : '';
  const figure =
    p.done !== undefined && p.total !== undefined
      ? pct
        ? `${p.done}/${p.total} · ${pct}`
        : `${p.done}/${p.total}`
      : p.done !== undefined
        ? `${p.done} done`
        : pct;
  const clock =
    p.elapsedSec !== undefined
      ? `${clockText(p.elapsedSec)}<${p.etaSec !== undefined ? clockText(p.etaSec) : '?'}`
      : p.etaSec !== undefined
        ? `${clockText(p.etaSec)} left`
        : '';
  const rate = p.rate !== undefined && p.rate > 0 ? rateText(p.rate) : '';
  return [figure, clock, rate].filter(Boolean).join(' · ');
}

/** how long since an ISO time, on tqdm's clock; '' when unknown */
function sinceText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? clockText((Date.now() - t) / 1000) : '';
}

/** tqdm's clock: 07:05, 1:02:13 */
function clockText(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 58.2 it/s, or 3.4 s/it once an item takes longer than a second */
function rateText(perSec: number): string {
  // a guard polling every 10 minutes moves a few items a minute
  if (perSec * 60 < 1) return `${(1 / perSec / 60).toFixed(1)} min/it`;
  if (perSec < 1) return `${(1 / perSec).toFixed(1)} s/it`;
  return `${perSec >= 100 ? Math.round(perSec) : perSec.toFixed(1)} it/s`;
}

function firstLine(s: string): string {
  const ln = s.split('\n', 1)[0] ?? '';
  return ln.length > 100 ? `${ln.slice(0, 100)}…` : ln;
}

/** the Tauri desktop window, as opposed to a phone or browser on the LAN/relay */
function inDesktopWindow(): boolean {
  return 'isTauri' in window && Boolean((window as { isTauri?: boolean }).isTauri);
}
