import type {
  ClaudeSessionInfo,
  HumanDTO,
  Params,
  ProjectTree,
  ProviderId,
  RecentProjectDTO,
  Result,
  SessionNode,
  SessionStateAgent,
  TaskDTO,
} from '@ateam/contract';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChatView } from './ChatView';
import { DirPicker } from './DirPicker';
import { Dropdown } from './Dropdown';
import { ExternalRunFeed } from './ExternalRunFeed';
import { FileView } from './FileView';
import { FoxWait } from './FoxWait';
import { HumanPicker } from './HumanPicker';
import { LanButton } from './LanPopover';
import { Market } from './Market';
import { MobileKeys } from './MobileKeys';
import { OpenWith } from './OpenWith';
import { Panel } from './Panel';
import { RolePicker } from './RolePicker';
import { RoleSelect } from './RoleSelect';
import { Settings } from './Settings';
import { McpApproval } from './SettingsMcp';
import { Setup } from './Setup';
import { StreamView } from './StreamView';
import { Term, estimateTermDims } from './Term';
import { candidatesFromSessions } from './humanMention';
import { UpdateBanner } from './UpdateBanner';
import { avatarSrc } from './avatars';
import { fillComposer } from './composerRegistry';
import { dropOnComposer } from './composerRegistry';
import { loadLocations } from './filesLocations';
import { effectiveThreshold, nextAskAt } from './handoffSnooze';
import { pickLandingSession } from './landingSession';
import { useIsMobile } from './mobile';
import {
  lastActiveSessionId,
  projectIdOfSession,
  projectsByRecency,
  resolveNavProject,
} from './navProject';
import { ensureNotifyPermission, notify } from './notify';
import { cantFindMessage, openFailedMessage } from './openFeedback';
import { formatPathForInput } from './pathInsert';
import { screenHasPermissionMenu } from './permissions';
import { agentsToPersist } from './persistAgents';
import { projectStatus } from './projectStatus';
import { beginDrag, endDrag } from './resizeGate';
import { orderForRestore } from './restoreOrder';
import { rowStarted } from './rowTime';
import { type Rpc, connect } from './rpc';
import { isWithinActiveWindow, sessionActivityMs } from './sessionActivity';
import { reloadIfServerUiIsNewer } from './staleUi';
import { applyStreamFont, readStreamFont } from './streamFont';
import { readScreen } from './termRegistry';
import { filterTree, normalizeQuery } from './treeSearch';

type ThemeChoice = 'dark' | 'light';
type DesktopView = 'terminal' | 'stream';

/** Per-session view choices, as [sessionId, view] pairs. The first run after
 *  the upgrade converts the old set, whose entries meant "not this platform's
 *  default": stream on a desktop, terminal on a phone. */
function readViewChoice(key: string, isMobile: boolean): Map<string, DesktopView> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const pairs = JSON.parse(raw) as [string, DesktopView][];
      return new Map(pairs.filter(([, v]) => v === 'stream' || v === 'terminal'));
    }
    const old = JSON.parse(localStorage.getItem('ateam.viewmode.override') ?? '[]') as string[];
    const flipped: DesktopView = isMobile ? 'terminal' : 'stream';
    const m = new Map(old.map((id) => [id, flipped] as [string, DesktopView]));
    localStorage.setItem(key, JSON.stringify([...m]));
    return m;
  } catch {
    return new Map();
  }
}
const THEME_KEY = 'ateam.theme';
function applyTheme(t: ThemeChoice): void {
  document.documentElement.dataset.theme = t === 'light' ? 'light' : '';
}
function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

const baseName = (d: string): string => d.split('/').filter(Boolean).pop() ?? d;

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

const TREE_WIDTH_KEY = 'ateam.tree.width';
const TREE_OPEN_KEY = 'ateam.tree.open';
const OPENER_KEY = 'ateam.defaultOpener';
/** the session this DEVICE was last looking at. Per-browser on purpose: a
 *  phone reopening its home-screen app must land back where it was, without
 *  dragging the desktop's focus around (or being dragged by it). */
const FOCUS_KEY = 'ateam.focus';
const ACTIVE_ONLY_KEY = 'ateam.tree.activeOnly';
/** top-bar status messages clear themselves after this long */
const STATUS_TTL_MS = 30_000;
/** handoff dialog auto-starts (on the session's current runtime) after this many seconds */
const HANDOFF_COUNTDOWN_S = 10;
const ACTIVE_WINDOW_KEY = 'ateam.tree.activeWindowH';
/** allowed "recently active" windows, in hours (24h default; 3/7/15 days) */
const ACTIVE_WINDOW_CHOICES = [24, 72, 168, 360] as const;
export const activeWindowLabel = (h: number): string => (h <= 24 ? `${h}h` : `${h / 24}d`);
// files the in-app File view can preview/edit (text + images + markdown);
// everything else opens with the user's chosen external app.
const PREVIEWABLE_EXT =
  /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif|txt|md|markdown|mdx|json|jsonc|js|jsx|ts|tsx|mjs|cjs|css|scss|less|html?|xml|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|sql|log|csv|tsv|lua|vue|svelte|graphql|proto)$/i;

/* ---- light SVG icons (currentColor stroke) ---- */
const Svg = (paths: JSX.Element): JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {paths}
  </svg>
);
const IconFolder = Svg(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
);
/* 11px twin of IconFolder — sits inline in a session row's second line */
const IconFolderSm = (
  <svg
    viewBox="0 0 24 24"
    width="11"
    height="11"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  </svg>
);
const IconPlus = Svg(<path d="M12 5v14M5 12h14" />);
/* the last two emoji in the app: 🛒 and ⚙ sat in the same column as three
   real line icons, one size and weight each */
const IconMarket = Svg(
  <>
    <path d="M3 5h2l2.2 9.6a2 2 0 0 0 2 1.6h6.9a2 2 0 0 0 2-1.5L20 8H6" />
    <circle cx="9.5" cy="19.5" r="1.2" />
    <circle cx="16.5" cy="19.5" r="1.2" />
  </>,
);
const IconGear = Svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5" />
  </>,
);
/* checklist — two ticked lines; the tasks vocabulary, not a bare checkmark
   (a lone ✓ reads as "done", which is the opposite of what the bar means) */
const IconCheck = Svg(
  <>
    <path d="m3.5 7 2.2 2.2L10 5" />
    <path d="M13 8h7.5" />
    <path d="m3.5 16 2.2 2.2L10 14" />
    <path d="M13 17h7.5" />
  </>,
);
const IconTerminal = Svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </>,
);
const IconChat = Svg(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 21 12Z" />);
/* team chat — two overlapping bubbles, distinct from the single-bubble stream
   toggle above; the always-on entry to chat mode. */
const IconTeamChat = Svg(
  <>
    <path d="M8 10a6 6 0 0 1 12 0 6 6 0 0 1-8.7 5.3L8 16l.6-2.5A6 6 0 0 1 8 10Z" />
    <path d="M6.5 8.2A5.5 5.5 0 0 0 4 17l-1 3.5 3.3-1.2a5.5 5.5 0 0 0 6.7-1.6" />
  </>,
);
/* Top bar, all one family. These four were text glyphs (▥ ◨ ⇄) and an emoji
   (✋): every one of them drew at a different weight and size next to the real
   icons, which is what made the row look thrown together. */
const IconSidebar = Svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </>,
);
const IconPanel = Svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </>,
);
/* handoff: the work leaves this box and carries on in the next one */
const IconHandoff = Svg(
  <>
    <path d="M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5" />
    <path d="m9 8 4 4-4 4M13 12H3" />
  </>,
);
const IconSwap = Svg(<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" />);
const IconPencil = Svg(
  <>
    <path d="M4 20h4L19 9a2 2 0 0 0-3-3L5 17z" />
    <path d="M15 6l3 3" />
  </>,
);
const IconFolderPlus = Svg(
  <>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 11v6M9 14h6" />
  </>,
);
const IconResume = Svg(
  <>
    <path d="M3 12a9 9 0 1 1 3 6.7" />
    <path d="M3 19v-5h5" />
  </>,
);
const IconTrash = Svg(
  <>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
    <path d="M10 11v6M14 11v6" />
  </>,
);
const IconCog = Svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </>,
);

interface NewForm {
  humanId: string; // '' = create new human
  name: string;
  role: string;
  dir: string; // '' = directory-less (talk to the human)
  providerId: ProviderId; // which agent CLI drives the session (default claude)
}

// The open set is persisted by the CORE to ~/.ateam/tui-state.json (the
// same file the TUI uses) via sessionState.* — so TUI and GUI restore the
// same workspace. No browser localStorage.

/** Small inline popover anchored to a session-row's human tag. Lets the
 *  user pick an existing Human or quickly create a new one and reassign
 *  the session to it. Closes on outside click / Esc. */
function ReassignPop({
  currentHumanId,
  humans,
  onPick,
  onCreate,
  onClose,
}: {
  currentHumanId: string;
  humans: HumanDTO[];
  onPick: (humanId: string) => void;
  onCreate: (name: string, role: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<'pick' | 'new'>('pick');
  const [name, setName] = useState('');
  const [role, setRole] = useState('coder');
  const popRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // defer one tick so the click that OPENED the popover doesn't
    // immediately close it via the document listener
    const t = setTimeout(() => document.addEventListener('mousedown', off), 0);
    document.addEventListener('keydown', esc);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', off);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  return (
    <div
      ref={popRef}
      className="reassign-pop"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {mode === 'pick' ? (
        <>
          <div className="reassign-hd">Reassign to…</div>
          {humans.map((h) => (
            <button
              type="button"
              key={h.id}
              className={`reassign-item${h.id === currentHumanId ? ' current' : ''}`}
              disabled={h.id === currentHumanId}
              onClick={() => onPick(h.id)}
            >
              <b>{h.name}</b> <span className="muted small">[{h.role}]</span>
              {h.id === currentHumanId && <span className="muted small"> · current</span>}
            </button>
          ))}
          <button
            type="button"
            className="reassign-item reassign-new"
            onClick={() => setMode('new')}
          >
            ＋ New human…
          </button>
        </>
      ) : (
        <>
          <div className="reassign-hd">New human</div>
          <label className="reassign-field">
            <span className="muted small">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. designer-1"
            />
          </label>
          <label className="reassign-field">
            <span className="muted small">Role</span>
            <RoleSelect value={role} onChange={setRole} />
          </label>
          <div className="reassign-actions">
            <button type="button" onClick={() => setMode('pick')}>
              ← Back
            </button>
            <button
              type="button"
              className="primary"
              disabled={!name.trim()}
              onClick={() => onCreate(name, role)}
            >
              Create & reassign
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function App(): JSX.Element {
  const [rpc, setRpc] = useState<Rpc | null>(null);
  const [err, setErr] = useState('');
  const [tree, setTree] = useState<ProjectTree[]>([]);
  const [openTasks, setOpenTasks] = useState<TaskDTO[]>([]);
  const [focused, setFocused] = useState('');
  const [humans, setHumans] = useState<HumanDTO[]>([]);
  const [recent, setRecent] = useState<RecentProjectDTO[]>([]);
  const [status, setStatus] = useState('');
  // transient toast semantics: a status line clears itself after 30s so a
  // stale "handoff requested…" from an hour ago doesn't sit in the top bar.
  // Every new message restarts the clock; '' cancels it.
  const [statusSeq, setStatusSeq] = useState(0);
  useEffect(() => {
    if (!status) return;
    setStatusSeq((n) => n + 1);
    const t = setTimeout(() => setStatus(''), STATUS_TTL_MS);
    return () => clearTimeout(t);
  }, [status]);
  const [modal, setModal] = useState<'none' | 'new' | 'resume' | 'newProject'>('none');
  const [form, setForm] = useState<NewForm>({
    humanId: '',
    name: 'coder-1',
    role: 'coder',
    dir: '',
    providerId: 'claude',
  });
  // agent-CLI runtimes detected on this machine (claude/codex/opencode/cursor/agy) — powers
  // the New session "Runtime" picker. Only `available` ones are offered.
  const [providers, setProviders] = useState<Result<'provider.list'>['providers']>([]);
  const availableProviders = useMemo(() => providers.filter((p) => p.available), [providers]);
  useEffect(() => {
    if (!rpc) return;
    void rpc
      .request('provider.list', {})
      .then((r) => setProviders(r.providers))
      .catch(() => {});
  }, [rpc]);
  // New-project modal: either make a fresh directory under `npParent` or
  // adopt an existing one (`npDir`), then start the first session there.
  const [npMode, setNpMode] = useState<'create' | 'existing'>('create');
  const [npParent, setNpParent] = useState('');
  const [npName, setNpName] = useState('');
  const [npDir, setNpDir] = useState('');
  const [npHumanId, setNpHumanId] = useState('');
  const [npNewName, setNpNewName] = useState('coder-1');
  const [npRole, setNpRole] = useState('coder');
  const [resumeDir, setResumeDir] = useState('');
  const [resumeList, setResumeList] = useState<ClaudeSessionInfo[]>([]);
  // who is resuming — same shape as the New-session human picker so the
  // resumed PTY is bound to the right human (was wrongly synthesizing one
  // named after the project, creating a phantom human per resume).
  const [resumeHumanId, setResumeHumanId] = useState('');
  const [resumeName, setResumeName] = useState('coder-1');
  const [resumeRole, setResumeRole] = useState('coder');
  const modalRef = useRef<HTMLDivElement | null>(null);
  // when a modal opens, steal focus from xterm so the keyboard goes here,
  // and lock Esc to dismiss. Without this, xterm's hidden textarea keeps
  // capturing keystrokes even though the backdrop is visually on top.
  useEffect(() => {
    if (modal === 'none') return;
    const m = modalRef.current;
    if (m) {
      const focusable = m.querySelector<HTMLElement>('input, select, button, [tabindex]');
      (focusable ?? m).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModal('none');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);
  const [busy, setBusy] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  // phone-class viewport: side panes start collapsed and open as drawers over
  // the terminal; everything else is the same app (same sessions, same RPC).
  const isMobile = useIsMobile();
  // Served through the relay? (its API answers on the same origin.) Then the
  // top bar offers "switch machine" — clears the device cookie and returns
  // to the relay's host picker.
  const [relayMode, setRelayMode] = useState(false);
  /** Name of the machine this client is talking to. A phone can be tunnelled
   *  into any of several machines and the bar otherwise gives no clue which
   *  one it reached — so the brand carries it. */
  const [machineName, setMachineName] = useState('');
  useEffect(() => {
    if ('isTauri' in window) return;
    fetch('/relay/api/devices')
      // must be a JSON answer: the LAN server SPA-fallbacks unknown paths to
      // index.html with 200, which is NOT the relay
      .then((r) => setRelayMode(r.ok && (r.headers.get('content-type') ?? '').includes('json')))
      .catch(() => {});
  }, []);
  const switchMachine = useCallback(() => {
    void fetch('/relay/api/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
      .catch(() => {})
      .then(() => window.location.replace('/relay/pick'));
  }, []);
  // Soft-keyboard handling: mobile browsers overlay the keyboard instead of
  // resizing the page, hiding whatever you type. Track visualViewport and
  // size the app to it, so the layout (terminal + key bar) stays visible.
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = (): void => {
      // Only pin the height while the soft keyboard is actually up. Pinning
      // it at rest broke iOS standalone (home-screen) mode: the initial
      // visualViewport there under-reports and the app showed a dead strip
      // at the bottom.
      const keyboardUp = vv.height < window.innerHeight - 60;
      if (keyboardUp) {
        document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
        // The VISIBLE area is [offsetTop, offsetTop + height] — when iOS
        // scrolls the layout viewport to expose the focused input (and
        // scrollTo below can't win), an app drawn from y=0 has its top
        // offscreen and its BOTTOM strip under the keyboard. Shifting by
        // offsetTop puts our height exactly over the visible band. `top`,
        // not transform: a transform would turn .app into the containing
        // block for every position:fixed overlay inside it.
        document.documentElement.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`);
      } else {
        document.documentElement.style.removeProperty('--vvh');
        document.documentElement.style.removeProperty('--vvt');
      }
      window.scrollTo(0, 0);
    };
    // iOS ignores scrollTo (and keeps moving the viewport) while the
    // keyboard slides in — a single apply() at the resize event leaves the
    // page half-scrolled. Re-apply every frame across the animation window.
    let raf = 0;
    let until = 0;
    const applyFor = (ms: number): void => {
      until = performance.now() + ms;
      cancelAnimationFrame(raf);
      const tick = (): void => {
        apply();
        if (performance.now() < until) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    const onVv = (): void => applyFor(400);
    // focus is what SUMMONS the keyboard; the first vv resize arrives
    // mid-animation. Start the loop at the cause, not the symptom.
    const onFocusIn = (): void => applyFor(800);
    apply();
    vv.addEventListener('resize', onVv);
    vv.addEventListener('scroll', onVv);
    window.addEventListener('focusin', onFocusIn);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener('resize', onVv);
      vv.removeEventListener('scroll', onVv);
      window.removeEventListener('focusin', onFocusIn);
      document.documentElement.style.removeProperty('--vvh');
      document.documentElement.style.removeProperty('--vvt');
    };
  }, [isMobile]);
  const mobileInitRef = useRef(false);
  useEffect(() => {
    if (!isMobile || mobileInitRef.current) return;
    mobileInitRef.current = true;
    setPanelOpen(false);
    setTreeOpen(false);
  }, [isMobile]);
  const [zoom, setZoom] = useState(false);
  const [groupBy, setGroupBy] = useState<'project' | 'human'>('project');
  /** the tree's search box; '' = not searching */
  const [treeQuery, setTreeQuery] = useState('');
  const searching = normalizeQuery(treeQuery) !== '';
  // "recently active" tree filter: hide sessions with no new transcript
  // activity within the configured window (Settings → General).
  const [activeOnly, setActiveOnly] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ACTIVE_ONLY_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [activeWindowH, setActiveWindowH] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem(ACTIVE_WINDOW_KEY));
      return (ACTIVE_WINDOW_CHOICES as readonly number[]).includes(n) ? n : 24;
    } catch {
      return 24;
    }
  });
  const toggleActiveOnly = useCallback(() => {
    setActiveOnly((v) => {
      try {
        localStorage.setItem(ACTIVE_ONLY_KEY, v ? '0' : '1');
      } catch {
        /* private mode */
      }
      return !v;
    });
  }, []);
  const setActiveWindow = useCallback((h: number) => {
    setActiveWindowH(h);
    try {
      localStorage.setItem(ACTIVE_WINDOW_KEY, String(h));
    } catch {
      /* private mode */
    }
  }, []);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [theme, setThemeState] = useState<ThemeChoice>(() => {
    const t = readTheme();
    applyTheme(t);
    applyStreamFont(readStreamFont()); // Settings → Appearance → Stream text
    return t;
  });
  const setTheme = useCallback((t: ThemeChoice) => {
    setThemeState(t);
    applyTheme(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* storage may be unavailable */
    }
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [marketOpen, setMarketOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [defaultAppName, setDefaultAppNameState] = useState<string>(() => {
    try {
      return localStorage.getItem(OPENER_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const setDefaultAppName = useCallback((name: string) => {
    setDefaultAppNameState(name);
    try {
      localStorage.setItem(OPENER_KEY, name);
    } catch {
      /* ignore */
    }
  }, []);
  // Files we can preview/edit inside the app; anything else opens externally.
  // `token` bumps on every open request so reopening a file whose path is
  // unchanged (it was closed, then clicked again) still re-selects it — a
  // plain `file` prop would compare equal and FileView's open effect would
  // no-op, leaving a closed image un-reopenable.
  const openTokenRef = useRef(0);
  const [fileView, setFileView] = useState<{
    dir: string;
    file?: string;
    line?: number;
    token?: number;
  } | null>(null);
  /** session the user clicked that turned out to be running as a Claude Code
   *  background agent — Ateam does not take those over, so the only way in is
   *  a forked copy, and that is the user's call to make */
  const [forkPrompt, setForkPrompt] = useState<string | null>(null);
  /** External MCP grants whose project folder no longer exists. Told once per
   *  launch; "OK" only dismisses (the server already skips them). */
  const [staleMcpProjects, setStaleMcpProjects] = useState<string[]>([]);
  const staleMcpToldRef = useRef(false);
  useEffect(() => {
    if (!rpc || staleMcpToldRef.current || relayMode) return;
    staleMcpToldRef.current = true;
    void rpc
      .request('externalMcp.status', {})
      .then((m) => setStaleMcpProjects(m.staleProjects ?? []))
      .catch(() => {});
  }, [rpc, relayMode]);
  /** a terminal link that matched several files the agent touched — the user
   *  picks rather than us opening the wrong one */
  const [pathPick, setPathPick] = useState<{
    ref: string;
    candidates: string[];
    line?: number;
  } | null>(null);
  // Files mode squeezes the conversation instead of covering it — the
  // session tree auto-collapses while a FileView is open and restores to
  // whatever the user had when it closes (localStorage untouched).
  const treeBeforeFileViewRef = useRef<boolean | null>(null);
  const closeFileView = useCallback(() => setFileView(null), []);
  // last non-null fileView, kept so the panel stays mounted (with content)
  // while its slide-out animation runs after fileView clears.
  const [lastFv, setLastFv] = useState<{
    dir: string;
    file?: string;
    line?: number;
    token?: number;
  } | null>(null);
  useEffect(() => {
    if (fileView) setLastFv(fileView);
  }, [fileView]);
  useEffect(() => {
    if (fileView) {
      setTreeOpen((cur) => {
        if (treeBeforeFileViewRef.current === null) treeBeforeFileViewRef.current = cur;
        return false;
      });
    } else if (treeBeforeFileViewRef.current !== null) {
      setTreeOpen(treeBeforeFileViewRef.current);
      treeBeforeFileViewRef.current = null;
    }
  }, [fileView]);

  /** Open with the OS system default handler (empty appName → `open` /
   *  `xdg-open` / `start`). Used by File view "Open externally" and by
   *  preview-unsupported files so a .pdf / .zip / .html opens with whatever
   *  the OS associates — never forced into the OpenWith IDE (VS Code was the
   *  old auto-default and that was wrong for this button). */
  const openWithSystem = useCallback((path: string, cwd?: string) => {
    const r = rpcRef.current;
    if (!r || !path) return;
    void r
      .request('app.openPath', { appName: '', path, cwd })
      .then((res) => {
        if (!res.ok) setStatus(openFailedMessage(path, res.err));
      })
      .catch((e) => setStatus(openFailedMessage(path, e)));
  }, []);
  /** open a path (file or dir). Supported files (text / image / markdown) and
   *  directories open in the in-app File view; unsupported files fall back to
   *  the user's chosen external app. Threaded to the terminal link provider
   *  and the workspace file list.
   *
   *  A RELATIVE path (a repo-relative terminal link like `pkg/CHANGELOG.md`)
   *  is resolved against the session cwd AND the project's attached Files-panel
   *  locations — the first candidate that exists wins. Without this, a link
   *  rooted in an attached dir was blindly joined to the session cwd and 404'd. */
  /** Show an absolute path: previewable files and directories open in the
   *  in-app File view (jumping to `line` when the link carried one), anything
   *  else goes to the user's external app. */
  const openResolved = useCallback(
    (abs: string, line?: number) => {
      const base = abs.split('/').pop() ?? '';
      const dir = abs.slice(0, abs.lastIndexOf('/')) || '/';
      if (PREVIEWABLE_EXT.test(base)) {
        setFileView({ dir, file: abs, token: ++openTokenRef.current, ...(line ? { line } : {}) });
      } else if (!/\.[a-z0-9]+$/i.test(base)) {
        setFileView({ dir: abs, token: ++openTokenRef.current }); // no extension → treat as a directory to browse
      } else {
        openWithSystem(abs);
      }
    },
    [openWithSystem],
  );

  const openPath = useCallback(
    (path: string, cwd?: string, line?: number, _column?: number) => {
      if (!path) return;
      void (async () => {
        let abs = path;
        const relative = !path.startsWith('/') && !path.startsWith('~');
        const sid = focusedRef.current;
        const r = rpcRef.current;
        // Relative: ask the session to resolve it — the agent's reported cwd,
        // the session cwd, this project's attached Files locations, then the
        // files THIS agent has actually opened (its transcript index). All map
        // lookups + a few existsSync, never a filesystem search (that froze the
        // app when path.locate tried it, 689ca5a).
        // Absolute: the same call is one existsSync. It used to be skipped, so
        // a path that no longer exists — or was cut short — opened an empty
        // file view or an external app's error instead of saying so.
        if (relative && (!sid || !r)) return;
        if (sid && r) {
          const res = await r
            .request('path.resolve', {
              sessionId: sid,
              ref: path,
              roots: relative && cwd ? await loadLocations(r, cwd).catch(() => []) : [],
            })
            .catch(() => null);
          if (res?.path) {
            abs = res.path;
          } else if (res && res.candidates.length > 1) {
            // same filename in several directories the agent touched — let
            // the user pick instead of guessing wrong
            setPathPick({ ref: path, candidates: res.candidates, line });
            return;
          } else if (res) {
            setStatus(cantFindMessage(path, res.tried));
            return;
          }
          // res === null: the RPC itself failed — fall through and try as given
        }
        openResolved(abs, line);
      })();
    },
    [openResolved],
  );
  const [treeOpen, setTreeOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TREE_OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem(TREE_WIDTH_KEY));
      return n >= 200 && n <= 480 ? n : 280;
    } catch {
      return 280;
    }
  });
  /* Below this the row can no longer hold avatar + two lines of text + a
     right-hand age without truncating the name, so the age — the least
     useful thing on the row — is the one that goes. 280 is the default
     width, so a bar the user never touched keeps its ages. */
  const treeNarrow = treeWidth < 270;
  const widthRef = useRef(treeWidth);
  useEffect(() => {
    widthRef.current = treeWidth;
  }, [treeWidth]);
  const startedAtRef = useRef<Map<string, number>>(new Map());
  const lastOutputRef = useRef<Map<string, number>>(new Map());
  /** Last REAL assistant message per session (transcript-turn driven).
   *  lastOutputRef above is raw PTY activity — right for the busy spinner
   *  and the restore boot gate, but cosmetic repaints (usage banners,
   *  update notices) keep resetting it, so the Panel's "Last message"
   *  readout keys on this map instead. */
  const lastTurnRef = useRef<Map<string, number>>(new Map());
  const [, setNowTick] = useState(0);
  useEffect(() => {
    // 400ms tick: tight enough to fade the "LLM working" spinner the moment
    // claude stops emitting. Unread is sticky until the user focuses the
    // session (that's what the yellow dot is for — "result waiting").
    const t = setInterval(() => setNowTick((x) => x + 1), 400);
    return () => clearInterval(t);
  }, []);
  const toggleTree = useCallback(() => {
    setTreeOpen((v) => {
      const n = !v;
      try {
        localStorage.setItem(TREE_OPEN_KEY, n ? '1' : '0');
      } catch {
        /* ignore */
      }
      return n;
    });
  }, []);
  // suppress the sidebar slide transition while a resize drag is live —
  // otherwise the 220ms width tween chases the cursor and feels rubbery
  const [treeDragging, setTreeDragging] = useState(false);
  // Per-session display mode. The DEFAULT is per platform — a phone gets the
  // stream (no columns, reflows, tap-to-answer), a desktop gets what Settings
  // says (`config.desktopView`, terminal unless changed) — and the map holds
  // the sessions someone switched by hand, as the view they chose. Stored as
  // the choice itself, not "differs from the default": the desktop default is
  // a setting now, and flipping it must not silently flip every toggled pane.
  const VIEW_CHOICE_KEY = 'ateam.viewmode.choice';
  const [desktopView, setDesktopViewState] = useState<DesktopView>('terminal');
  const [viewChoice, setViewChoice] = useState<Map<string, DesktopView>>(() =>
    readViewChoice(VIEW_CHOICE_KEY, isMobile),
  );
  const isStreamView = useCallback(
    (sessionId: string): boolean => {
      const chosen = viewChoice.get(sessionId);
      if (chosen) return chosen === 'stream';
      return isMobile || desktopView === 'stream';
    },
    [isMobile, desktopView, viewChoice],
  );
  const toggleStreamMode = useCallback(
    (sessionId: string) => {
      setViewChoice((prev) => {
        const n = new Map(prev);
        n.set(sessionId, isStreamView(sessionId) ? 'terminal' : 'stream');
        try {
          localStorage.setItem(VIEW_CHOICE_KEY, JSON.stringify([...n]));
        } catch {
          /* private mode */
        }
        return n;
      });
    },
    [isStreamView],
  );
  const setDesktopView = useCallback((v: DesktopView) => {
    setDesktopViewState(v);
    const r = rpcRef.current;
    if (r) void r.request('config.set', { desktopView: v });
  }, []);
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setTreeDragging(true);
    beginDrag();
    const startX = e.clientX;
    const startW = widthRef.current;
    const onMove = (ev: MouseEvent): void => {
      const w = Math.min(480, Math.max(200, startW + (ev.clientX - startX)));
      setTreeWidth(w);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setTreeDragging(false);
      endDrag();
      try {
        localStorage.setItem(TREE_WIDTH_KEY, String(widthRef.current));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);
  // files-panel width lives HERE (not in FileView) so the slide wrapper
  // can animate open/close around a fixed-width inner panel.
  const FV_WIDTH_KEY = 'ateam.fv.width';
  const [fvWidth, setFvWidth] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem(FV_WIDTH_KEY));
      return n >= 420 ? n : Math.round(window.innerWidth * 0.62);
    } catch {
      return Math.round(window.innerWidth * 0.62);
    }
  });
  /** How wide the file preview opens. On a phone the desktop arithmetic
   *  (leave 300px for the stage) left 102px of a 402px screen — a preview you
   *  could not read. There it takes the whole screen instead, floated over the
   *  conversation like the other drawers. */
  const fvOpenWidth = isMobile ? window.innerWidth : Math.min(fvWidth, window.innerWidth - 300);
  const [fvDragging, setFvDragging] = useState(false);
  const onFvResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setFvDragging(true);
    beginDrag();
    const wrap = (e.currentTarget as HTMLElement).parentElement;
    const onMove = (ev: MouseEvent): void => {
      const rect = wrap?.getBoundingClientRect();
      if (!rect) return;
      setFvWidth(Math.min(Math.max(420, rect.right - ev.clientX), window.innerWidth - 300));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setFvDragging(false);
      endDrag();
      setFvWidth((w) => {
        try {
          localStorage.setItem(FV_WIDTH_KEY, String(w));
        } catch {
          /* ignore */
        }
        return w;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  /** bumped when live assistant turns arrive so time-based derivations (the
   *  recently-active filter) re-evaluate without polling. Trailing-throttled:
   *  a burst of turn events (backlog drain, several busy sessions) must not
   *  become one full App re-render per event. */
  const [turnTick, setTurnTick] = useState(0);
  const turnTickPendingRef = useRef(false);
  const bumpTurnTick = useCallback(() => {
    if (turnTickPendingRef.current) return;
    turnTickPendingRef.current = true;
    setTimeout(() => {
      turnTickPendingRef.current = false;
      setTurnTick((t) => t + 1);
    }, 400);
  }, []);
  /** Sessions the user has actually TYPED into at least once this run.
   *  A session may only be flagged unread (green dot) AFTER it is
   *  engaged — this prevents replayed claude output on restore/first
   *  load from lighting every row green. Focus/select does NOT engage;
   *  only real keystrokes via Term.onUserInput do. */
  const [engaged, setEngaged] = useState<Set<string>>(new Set());
  /** Mirror of `engaged` for the session.output listener (registered once
   *  in the connect effect — must read the live value via ref, not the
   *  stale-closured state variable). */
  const engagedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    engagedRef.current = engaged;
  }, [engaged]);
  /** Sessions whose runtime TUI is currently showing a permission menu
   *  (the "1. Yes / 2. … / 3. No" signature). Drives the YELLOW dot.
   *  Set from the rolling-window menu detector below; cleared either
   *  when the menu signature drops out of the current window OR when
   *  the user focuses the session. */
  const [pendingMenu, setPendingMenu] = useState<Set<string>>(new Set());
  const [restorePrompt, setRestorePrompt] = useState<SessionStateAgent[] | null>(null);
  // config.autoResume: skip the dialog and restore everything on connect —
  // the headless flow (app restarted by a build script, user is on a phone)
  // must come back without anyone clicking anything. Spawn-side resume dedup
  // keeps several clients doing this at once from double-spawning.
  const [restoreAuto, setRestoreAuto] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState<string | undefined>(undefined);
  // which saved sessions the user wants to actually restore (by
  // claudeSessionId). Default = all. The dialog has per-row checkboxes
  // and three preset shortcuts: All / Active only / None.
  const [restorePicked, setRestorePicked] = useState<Set<string>>(() => new Set());
  // The ORDERED list of saved agents being restored this run (priority-first).
  // null = not in a load-all restore. While set, the not-yet-spawned agents
  // render as gray, non-clickable placeholder rows at the top of the tree.
  const [restoreQueue, setRestoreQueue] = useState<SessionStateAgent[] | null>(null);
  // claudeSessionIds that have finished spawning this restore run. A saved
  // agent is a GRAY placeholder iff it is in restoreQueue and NOT here.
  const [restoreLoadedIds, setRestoreLoadedIds] = useState<Set<string>>(() => new Set());
  // The set of saved sessions present in tui-state.json AT BOOT, captured
  // once and never cleared. The persist effect carries these forward as
  // "remembered" entries so unrestored sessions (when the user picked
  // Active-only or a partial subset) survive into the NEXT launch's
  // restore prompt instead of being clobbered to nothing.
  const [originalSavedAgents, setOriginalSavedAgents] = useState<SessionStateAgent[]>([]);
  // sessionId for which the "change human" popover is open (null = closed)
  const [reassignFor, setReassignFor] = useState<string | null>(null);
  // session pending delete-confirmation (null = no dialog open)
  const [confirmDelete, setConfirmDelete] = useState<SessionNode | null>(null);
  // successor → predecessor map. When a session.replaced event fires, the
  // UI swaps focused to the successor and renders the dual-pane stack
  // (old read-only above, banner, new live below) while a predecessor is
  // recorded for the focused session.
  const [predecessorOf, setPredecessorOf] = useState<
    Map<string, { oldId: string; handoffPath: string; at: string }>
  >(() => new Map());
  // per-session approx token estimate (polled). Drives the right-side
  // token bar on each tree row and feeds the auto-handoff trigger.
  const [tokenEst, setTokenEst] = useState<Map<string, number>>(() => new Map());
  // sessions whose handoff is currently in flight — we've injected the
  // prompt and are waiting for claude to write the doc + the backend to
  // emit session.replaced. While in flight, the Term renders a small
  // "processing" overlay and rejects keyboard input (so the user can't
  // accidentally clobber claude's response or fire another handoff).
  const [handoffInFlight, setHandoffInFlight] = useState<Set<string>>(() => new Set());
  /** Mark a session's handoff as in flight with a generous safety cap.
   *  Normally cleared by session.replaced; the cap only exists so a missed
   *  marker line can't lock the terminal forever. Big sessions genuinely
   *  take MINUTES to write their handoff doc — never make this short. */
  const markHandoffInFlight = useCallback((sessionId: string) => {
    setHandoffInFlight((s) => new Set(s).add(sessionId));
    setTimeout(() => {
      setHandoffInFlight((s) => {
        if (!s.has(sessionId)) return s;
        const n = new Set(s);
        n.delete(sessionId);
        return n;
      });
    }, 10 * 60_000);
  }, []);
  // Auto-handoff confirmation. When the focused session crosses the
  // threshold we ASK first instead of firing silently — the user can start
  // the handoff now or postpone it (+5k tokens, then we ask again).
  const [handoffPrompt, setHandoffPrompt] = useState<{
    sessionId: string;
    claudeSessionId: string;
    source: 'auto' | 'manual' | 'switch';
    tokens?: number;
    threshold?: number;
  } | null>(null);
  // runtime the successor will run on; seeded from the session when the
  // dialog opens. null = countdown paused (user touched the picker).
  const [handoffProvider, setHandoffProvider] = useState<ProviderId>('claude');
  const [handoffCountdown, setHandoffCountdown] = useState<number | null>(null);
  // auto-handoff threshold cached client-side so each row can render its
  // token bar (% filled = tokens / threshold) without an extra round-trip.
  const [tokenThreshold, setTokenThreshold] = useState(120_000);
  const [setup, setSetup] = useState<{ firstRun: boolean } | null>(null);
  const rpcRef = useRef<Rpc | null>(null);
  // The stage hosts every Term; measured up front so the core knows the pane
  // size BEFORE the first spawn (restore / New session right after launch) —
  // otherwise the first claude boots at the 120×32 fallback and its narrow
  // first frame stays mangled in the scrollback.
  const stageRef = useRef<HTMLElement | null>(null);
  const primeViewport = useCallback(() => {
    const r = rpcRef.current;
    const el = stageRef.current;
    if (!r || !el) return;
    const d = estimateTermDims(el);
    if (d) void r.request('session.viewport', d).catch(() => {});
  }, []);
  const restoringRef = useRef(false);
  const focusedRef = useRef('');
  /** last-viewed timestamp per session — updated when a session is focused
   *  AND when focus moves AWAY from it. Used as a grace period so trailing
   *  output of the turn you were just watching doesn'\''t re-flag unread. */
  const viewedAtRef = useRef<Map<string, number>>(new Map());
  /** Per-session rolling buffer of recent ANSI-stripped output (last 4KB).
   *  Used to detect whether claude's permission menu is CURRENTLY visible
   *  on screen — not "did we ever see one some chunk ago". A previous
   *  approach using time-based throttling lit the green dot for every
   *  cursor-blink / status-poll redraw; rolling buffer lets us answer
   *  "is the menu in the live frame right now". */
  const menuWindowRef = useRef<Map<string, string>>(new Map());
  const permissionTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(
    () => () => {
      for (const timer of permissionTimersRef.current.values()) clearTimeout(timer);
      permissionTimersRef.current.clear();
    },
    [],
  );
  const prevFocusedRef = useRef('');
  // System-notification bookkeeping: a live mirror of sessions (so the
  // output handler can resolve a session's Human name), plus edge-trackers so
  // we notify once per transition, not on every output chunk.
  const sessionsRef = useRef<SessionNode[]>([]);
  // Focused points at a DEAD sessionId? (app restarted: every conversation
  // came back under a fresh id; an in-place phone reconnect keeps the old
  // one in state and its inputs land in "no such session".) Re-bind to the
  // same CONVERSATION via the stable claudeSessionId as soon as the tree
  // shows it live again.
  useEffect(() => {
    const live = tree.flatMap((p) => p.sessions);
    if (live.length === 0) return;
    if (focused && live.some((s) => s.sessionId === focused)) return;
    let remembered = '';
    try {
      remembered = localStorage.getItem(FOCUS_KEY) ?? '';
    } catch {
      /* private mode */
    }
    const landing = pickLandingSession(live, remembered);
    if (landing) setFocused(landing.sessionId);
  }, [tree, focused]);
  // refresh is declared further down (needs state it closes over); the ref
  // lets earlier callbacks (select → wake) trigger a tree reload.
  const refreshRef = useRef<((r: Rpc) => Promise<void>) | null>(null);
  const projectNameRef = useRef<Map<string, string>>(new Map());
  const menuNotifiedRef = useRef<Set<string>>(new Set());
  const unreadNotifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (prevFocusedRef.current && prevFocusedRef.current !== focused) {
      viewedAtRef.current.set(prevFocusedRef.current, Date.now());
    }
    if (focused) viewedAtRef.current.set(focused, Date.now());
    prevFocusedRef.current = focused;
    focusedRef.current = focused;
    if (focused) {
      try {
        // the STABLE id: sessionIds die on every app restart, and the
        // remembered focus must survive one (see pickLandingSession)
        const cid = sessionsRef.current.find((s) => s.sessionId === focused)?.claudeSessionId;
        localStorage.setItem(FOCUS_KEY, cid ?? focused);
      } catch {
        /* private mode */
      }
    }
  }, [focused]);

  // Native (Finder/OS) file drop → insert the dropped path(s) into the focused
  // session's input. Tauri intercepts OS-originated drops, so the webview's own
  // DOM drop (Term, for Files-panel drags) never sees these — no double-insert.
  useEffect(() => {
    const isTauri =
      typeof window !== 'undefined' &&
      'isTauri' in window &&
      Boolean((window as { isTauri?: boolean }).isTauri);
    if (!isTauri) return;
    let un: (() => void) | undefined;
    let disposed = false;
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((e) => {
          if (e.payload.type !== 'drop') return;
          const sid = focusedRef.current;
          const r = rpcRef.current;
          if (!sid || !r) return;
          // in stream mode the PTY is hidden: the paths would land where
          // nobody can see them, so the stream's own composer takes them
          if (dropOnComposer(sid, e.payload.paths)) return;
          const data = e.payload.paths.map(formatPathForInput).join('');
          if (data) void r.request('session.input', { sessionId: sid, data }).catch(() => {});
        }),
      )
      .then((f) => {
        if (disposed) f();
        else un = f;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const select = useCallback((id: string) => {
    // clicking a hibernated session wakes it: the backend respawns claude
    // with --resume and hands back the successor node — focus that instead.
    const target = sessionsRef.current.find((s) => s.sessionId === id);
    if (target?.state === 'hibernated') {
      const r = rpcRef.current;
      if (r) {
        setStatus(`waking ${target.humanName}…`);
        void r
          .request('session.wake', { sessionId: id })
          .then(async (res) => {
            await refreshRef.current?.(r);
            setFocused(res.session.sessionId);
            setStatus('');
          })
          .catch((e: unknown) => {
            if ((e as { code?: string })?.code === 'bg_agent_running') {
              setForkPrompt(id); // running elsewhere — ask before copying it
              return;
            }
            setStatus(`wake failed: ${e instanceof Error ? e.message : String(e)}`);
          });
      }
      return;
    }
    setFocused(id);
    setUnread((u) => {
      if (!u.has(id)) return u;
      const n = new Set(u);
      n.delete(id);
      return n;
    });
    // user is now looking — clear the yellow menu indicator too
    setPendingMenu((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    // viewing resets the notify edge-trackers so the NEXT turn re-notifies
    menuNotifiedRef.current.delete(id);
    unreadNotifiedRef.current.delete(id);
  }, []);

  const engage = useCallback((id: string) => {
    setEngaged((s) => (s.has(id) ? s : new Set(s).add(id)));
  }, []);

  const sessions = useMemo<SessionNode[]>(() => tree.flatMap((p) => p.sessions), [tree]);
  /** `@@` in Stream: same-project peers + directory-less Chats. */
  const peerMentions = useMemo(() => {
    const self = sessions.find((s) => s.sessionId === focused);
    if (!self) return [];
    return candidatesFromSessions(sessions, {
      sessionId: self.sessionId,
      projectId: self.workspaceId === 'direct' ? undefined : self.projectId,
    });
  }, [sessions, focused]);
  /** Which face a message from ANOTHER session wears: find the session by the
   *  name it sent under, then the human running it. */
  const avatarOfSession = useCallback(
    (name: string): string | undefined => {
      const key = name.trim().toLowerCase();
      const s = sessions.find(
        (x) =>
          (x.sessionName ?? '').trim().toLowerCase() === key ||
          (x.agentName ?? '').trim().toLowerCase() === key ||
          (x.humanName ?? '').trim().toLowerCase() === key,
      );
      const h = humans.find((x) => x.id === s?.humanId || x.name.trim().toLowerCase() === key);
      return h?.avatarId;
    },
    [sessions, humans],
  );
  useEffect(() => {
    sessionsRef.current = sessions;
    // sessionId → project name, so notifications can say which project pings
    const m = new Map<string, string>();
    // notification titles are display text → alias wins when set
    for (const p of tree) for (const s of p.sessions) m.set(s.sessionId, p.alias ?? p.name);
    projectNameRef.current = m;
  }, [sessions, tree]);
  // ask for notification permission once, up front
  useEffect(() => {
    void ensureNotifyPermission();
  }, []);

  /** Recently-active gate for the tree filter. Activity = last transcript
   *  stamp / live turn, falling back to createdAt only for a fresh empty
   *  spawn. Never keys off "first seen this GUI run" — that used to make
   *  restored Cursor / missing-transcript rows forever pass a 24h filter.
   *  The focused session always stays visible. */
  const isActiveSession = useCallback(
    (s: SessionNode): boolean => {
      // a search is for finding a session, however long it has been quiet
      if (!activeOnly || searching) return true;
      if (s.sessionId === focused) return true;
      return isWithinActiveWindow(
        sessionActivityMs({
          lastActiveAt: s.lastActiveAt,
          createdAt: s.createdAt,
          lastTurnMs: lastTurnRef.current.get(s.sessionId),
        }),
        activeWindowH,
      );
    },
    [activeOnly, activeWindowH, focused, searching],
  );

  /** The left tree, grouped by either project (folders + Chats split out)
   *  or human (one group per human). Project view: directoryless sessions
   *  go in a separate "Chats" section so projects stay clean folders. */
  const groups = useMemo<
    { key: string; name: string; alias?: string; sessions: SessionNode[]; dir?: string }[]
  >(() => {
    if (groupBy === 'project') {
      return tree
        .map((p) => {
          // hide sessions superseded by an auto-handoff successor — the
          // user thinks of the new one as a continuation, not a sibling.
          // The predecessor's xterm still renders in the stage dual-pane
          // (App's `sessions` array is the unfiltered source for that).
          const dirSessions = p.sessions.filter(
            (s) => s.workspaceId !== 'direct' && !s.replacedBySessionId && isActiveSession(s),
          );
          return {
            key: p.projectId,
            name: p.name,
            // display-only override; `name` stays the real one everywhere
            // that persists or groups by it (buildAgents, spawn args…)
            alias: p.alias,
            sessions: dirSessions,
            // every workspace-bound session in the same project tree shares
            // the same cwd today (Workspace concept hasn't split a project yet);
            // pick the first as the canonical dir for the per-project ＋ button.
            dir: dirSessions[0]?.cwd,
          };
        })
        .filter((g) => g.sessions.length > 0);
    }
    const byHuman = new Map<string, { name: string; sessions: SessionNode[] }>();
    for (const s of sessions) {
      // skip handed-off predecessors — same rationale as the project view
      if (s.replacedBySessionId) continue;
      if (!isActiveSession(s)) continue;
      const g = byHuman.get(s.humanId) ?? { name: s.humanName, sessions: [] };
      g.sessions.push(s);
      byHuman.set(s.humanId, g);
    }
    return [...byHuman.entries()].map(([key, v]) => ({ key, name: v.name, sessions: v.sessions }));
    // turnTick re-evaluates the time-based filter as live turns arrive
  }, [tree, sessions, groupBy, isActiveSession, turnTick]);

  // Collapse/expand a tree group. Keyed by g.key (projectId or humanId,
  // distinct namespaces so one Set is safe for both views). New Set each
  // call — never mutate prev.
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Which project the collapsed-nav shows. It FOLLOWS the focused session's
  // project by default, but the project dropdown can override it (navProjectId)
  // to browse another project's sessions WITHOUT waking one — picking a project
  // just re-lists its session chips; the user then clicks a chip to focus/wake.
  // Any focus change clears the override so the bar snaps back to follow focus
  // (this is also why the old "select the first session" approach reverted: the
  // other project's sessions are hibernated, so select() went async and focused
  // never changed synchronously, bouncing the controlled <select> straight back).
  // project whose display alias is being edited inline in the tree header
  // ({key, value}); null = not editing. The alias is a label only — see
  // project-alias.ts on why `name` must stay untouched.
  const [renamingProject, setRenamingProject] = useState<{ key: string; value: string } | null>(
    null,
  );
  const commitProjectAlias = useCallback(async () => {
    const r = rpcRef.current;
    const edit = renamingProject;
    setRenamingProject(null);
    if (!r || !edit) return;
    try {
      await r.request('project.setAlias', { projectId: edit.key, alias: edit.value });
      await refreshRef.current?.(r);
    } catch (e) {
      setStatus(`rename failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [renamingProject]);

  /** Chip whose hover actions are showing, with the chip's viewport rect.
   *  The actions render in a portal ABOVE that rect: drawn inside the chip
   *  they hid its own title, and `.collapsed-nav-sessions` scrolls
   *  horizontally (overflow-y is therefore clipped too), so anything painted
   *  outside the chip's box would be cut off. */
  const [chipHover, setChipHover] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [navProjectId, setNavProjectId] = useState<string | null>(null);
  useEffect(() => {
    setNavProjectId(null);
  }, [focused]);
  // Remember the last resolved project so a momentarily-unresolvable focus (the
  // brief window after a chip click / wake where the new sessionId isn't in
  // `sessions` yet) holds the current project instead of snapping to tree[0].
  //
  // Keep the project's ID, never the ProjectTree OBJECT: a captured object is a
  // frozen snapshot of that project's session list. Falling back to it returned
  // stale sessions AND — because its identity never changes — pinned the
  // `currentProjectSessions` memo, so neither the 5s poll nor a session.replaced
  // refresh could thaw it. Symptom: after a handoff the collapsed-nav still
  // offered the retired predecessor's chip, and clicking it opened the dead
  // session (#21 — the earlier exit-129 fix was a different bug).
  const lastProjectIdRef = useRef<string | undefined>(undefined);
  const currentProject = useMemo<ProjectTree | undefined>(() => {
    const found = resolveNavProject({
      tree,
      // via the tree — session.projectId is a uuid the tree does not use as key
      focusedProjectId: projectIdOfSession(tree, focused),
      navProjectId,
      lastProjectId: lastProjectIdRef.current,
    });
    if (found) lastProjectIdRef.current = found.projectId;
    return found;
  }, [tree, sessions, focused, navProjectId]);
  const currentProjectSessions = useMemo<SessionNode[]>(
    () => (currentProject?.sessions ?? []).filter((s) => !s.replacedBySessionId),
    [currentProject],
  );

  /** What the tree shows while searching: sessions matched by their own name
   *  or their project's name/alias (see treeSearch.ts). */
  const projectOfSession = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of tree) for (const ss of p.sessions) m.set(ss.sessionId, [p.name, p.alias ?? '']);
    return m;
  }, [tree]);
  const shownGroups = useMemo(
    () =>
      filterTree<SessionNode, (typeof groups)[number]>(
        groups,
        treeQuery,
        (x) => x.sessionName,
        (x) => projectOfSession.get(x.sessionId) ?? [],
        groupBy === 'project',
      ),
    [groups, treeQuery, projectOfSession, groupBy],
  );

  const chatSessions = useMemo<SessionNode[]>(
    () =>
      groupBy === 'project'
        ? sessions.filter(
            (s) => s.workspaceId === 'direct' && !s.replacedBySessionId && isActiveSession(s),
          )
        : [],
    // turnTick re-evaluates the time-based filter as live turns arrive
    [sessions, groupBy, isActiveSession, turnTick],
  );
  const shownChats = useMemo(() => {
    const q = normalizeQuery(treeQuery);
    return q
      ? chatSessions.filter((x) => (x.sessionName ?? '').toLowerCase().includes(q))
      : chatSessions;
  }, [chatSessions, treeQuery]);

  // Saved sessions queued for restore that have NOT yet spawned — rendered
  // as gray, non-clickable placeholder rows. Excludes any whose
  // claudeSessionId already exists live (guards the brief refresh overlap so
  // a row never appears twice: once gray + once live).
  const pendingAgents = useMemo<SessionStateAgent[]>(
    () =>
      (restoreQueue ?? []).filter(
        (a) =>
          !restoreLoadedIds.has(a.claudeSessionId) &&
          !sessions.some((s) => s.claudeSessionId === a.claudeSessionId),
      ),
    [restoreQueue, restoreLoadedIds, sessions],
  );

  const refresh = useCallback(async (r: Rpc) => {
    const res = await r.request('session.list', {});
    setTree(res.projects);
    setTreeReady(true); // the boot splash's real finish line
    // track first-seen time per session so the sidebar can show "5m" / "1h"
    const live = new Set(res.projects.flatMap((p) => p.sessions.map((s) => s.sessionId)));
    const now = Date.now();
    for (const id of live) if (!startedAtRef.current.has(id)) startedAtRef.current.set(id, now);
    for (const id of [...startedAtRef.current.keys()])
      if (!live.has(id)) startedAtRef.current.delete(id);
    for (const id of [...lastOutputRef.current.keys()])
      if (!live.has(id)) lastOutputRef.current.delete(id);
    for (const id of [...lastTurnRef.current.keys()])
      if (!live.has(id)) lastTurnRef.current.delete(id);
    for (const id of [...viewedAtRef.current.keys()])
      if (!live.has(id)) viewedAtRef.current.delete(id);
    setEngaged((s) => {
      const n = new Set([...s].filter((id) => live.has(id)));
      return n.size === s.size ? s : n;
    });
    setFocused((f) => f || res.projects.flatMap((p) => p.sessions)[0]?.sessionId || '');
  }, []);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Lost connections self-heal: a phone that locks (or roams networks) drops
  // the WebSocket, and the saved home-screen app has no address bar to
  // refresh with. On close: retry with backoff, retry IMMEDIATELY when the
  // page returns to the foreground, and after repeated failures reload the
  // whole page (which re-walks the relay/LAN login gate).
  const [reconnecting, setReconnecting] = useState(false);
  /* Boot splash. It holds the screen until the app has something true to show
     — connected AND the first session list in hand — because the alternative
     is an empty sidebar that fills in a beat later and reads as "no sessions".
     Two timers bound it at both ends: a splash that comes and goes inside
     100ms reads as a glitch rather than as loading, so one second is the
     floor; and a session.list that never answers must not wedge the app
     behind the splash, so eight seconds is the ceiling (the 5s poller keeps
     retrying underneath either way). */
  const [treeReady, setTreeReady] = useState(false);
  const [bootFloorPassed, setBootFloorPassed] = useState(false);
  const [bootIsSlow, setBootIsSlow] = useState(false);
  useEffect(() => {
    const floor = setTimeout(() => setBootFloorPassed(true), 1000);
    const slow = setTimeout(() => setBootIsSlow(true), 6000);
    const ceiling = setTimeout(() => setTreeReady(true), 8000);
    return () => {
      clearTimeout(floor);
      clearTimeout(slow);
      clearTimeout(ceiling);
    };
  }, []);
  const reconnectRef = useRef<{ tries: number; timer?: ReturnType<typeof setTimeout> }>({
    tries: 0,
  });
  useEffect(() => {
    let alive = true;
    const establish = (): void => {
      if (!alive) return;
      const wasDown = reconnectRef.current.tries > 0;
      connect()
        .then(async (r) => {
          if (!alive) return;
          reconnectRef.current.tries = 0;
          setReconnecting(false);
          setErr('');
          // The desktop can be UPGRADED while a phone keeps this page open: the
          // socket drops for a few seconds, reconnects, and the browser happily
          // goes on running the JS it downloaded before the upgrade. Every fix
          // then looks unshipped on the phone, and you debug the wrong build.
          // (The existing give-up reload only fires after ~6 failed tries; a
          // restart is back long before that.) So on every REconnect, compare
          // the script the server is serving now with the ones this document
          // actually loaded, and reload if they have parted ways.
          if (wasDown) void reloadIfServerUiIsNewer();
          rpcRef.current = r;
          setRpc(r);
          // the stage is laid out by now — prime the pane size before anything spawns
          setTimeout(primeViewport, 0);
          r.onClose(() => {
            if (!alive) return;
            setReconnecting(true);
            const rec = reconnectRef.current;
            rec.tries++;
            if (rec.tries > 6 && !('isTauri' in window)) {
              // give up on in-place reconnects — a full reload re-runs the
              // relay gate (fresh cookies / picker) and always converges
              window.location.reload();
              return;
            }
            rec.timer = setTimeout(establish, Math.min(1000 * 2 ** rec.tries, 10_000));
          });
          r.on('session.status', () => void refresh(r));
          r.on('meta.progress', (d) => setStatus(`${d.phase}${d.detail ? ` · ${d.detail}` : ''}`));
          r.on('evolution.experience', (d) => setStatus(`+exp ${d.domain}: ${d.title}`));
          r.on('evolution.skill', (d) => setStatus(`+${d.source} skill ×${d.count}`));
          r.on('session.output', (d) => {
            // claude TUI streams cosmetic redraws (cursor blink, status-line
            // updates, the timer-driven "thinking…" spinner) even when no
            // real LLM content is arriving. Strip ANSI + count printable
            // chars; anything below threshold is purely visual and must NOT
            // light the green "unread" dot or keep "busy" stuck.
            const stripped = d.chunk
              .replace(/\x1b\][^\x07]*\x07/g, '')
              .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

            // Per-session rolling window — drives the YELLOW dot.
            const prev = menuWindowRef.current.get(d.sessionId) ?? '';
            const next = (prev + stripped).slice(-4096);
            menuWindowRef.current.set(d.sessionId, next);
            const updatePermissionMenu = (): void => {
              const providerId = sessionsRef.current.find(
                (s) => s.sessionId === d.sessionId,
              )?.providerId;
              const menuNow =
                providerId === 'codex'
                  ? screenHasPermissionMenu(readScreen(d.sessionId), 'codex')
                  : /1\.\s*Yes[\s\S]{0,400}3\.\s*No/i.test(next);
              setPendingMenu((s) => {
                const had = s.has(d.sessionId);
                if (had === menuNow) return s;
                const n = new Set(s);
                if (menuNow) n.add(d.sessionId);
                else n.delete(d.sessionId);
                return n;
              });
              // system notification: fire once when a session first needs a
              // decision (edge-triggered; reset when the menu clears / on view).
              if (menuNow) {
                if (
                  !menuNotifiedRef.current.has(d.sessionId) &&
                  d.sessionId !== focusedRef.current
                ) {
                  menuNotifiedRef.current.add(d.sessionId);
                  const s = sessionsRef.current.find((x) => x.sessionId === d.sessionId);
                  const proj = projectNameRef.current.get(d.sessionId);
                  const who = s?.humanName ?? 'Ateam';
                  notify(
                    proj ? `${who} · ${proj}` : who,
                    'needs your input — waiting on a confirmation',
                  );
                }
              } else {
                menuNotifiedRef.current.delete(d.sessionId);
              }
            };
            if (
              sessionsRef.current.find((s) => s.sessionId === d.sessionId)?.providerId === 'codex'
            ) {
              clearTimeout(permissionTimersRef.current.get(d.sessionId));
              permissionTimersRef.current.set(
                d.sessionId,
                setTimeout(() => {
                  permissionTimersRef.current.delete(d.sessionId);
                  updatePermissionMenu();
                }, 100),
              );
            } else {
              updatePermissionMenu();
            }

            const printable = stripped.replace(/\s/g, '').length;
            if (printable < 4) return; // cosmetic only — nothing to flag
            lastOutputRef.current.set(d.sessionId, Date.now());
            // NOTE: the green "unread" dot + system notification are NOT
            // driven from here anymore. The PTY stream repaints without new
            // content (usage-limit banners, update notices, status-line
            // redraws — hourly waves across ALL sessions), so raw output can
            // never distinguish "new message" from "cosmetic repaint". The
            // semantic signal is session.turn below, emitted by core only
            // when claude's transcript file actually grows.
          });
          r.on('session.turn', (d) => {
            // real model OUTPUT only — thinking is the model talking to
            // itself, and must not light unread badges / notifications
            if (d.turn.role !== 'assistant' || d.turn.kind === 'thinking') return;
            const id = d.sessionId;
            // "last real message" clock — for every session, focused or not
            const at = Date.parse(d.turn.at);
            lastTurnRef.current.set(id, Number.isNaN(at) ? Date.now() : at);
            bumpTurnTick();
            if (id === focusedRef.current) return;
            // grace: a turn that lands right as you switch away was watched
            const viewed = viewedAtRef.current.get(id) ?? 0;
            if (Date.now() - viewed < 2000) return;
            // only sessions the user has typed into this run ping back
            if (!engagedRef.current.has(id)) return;
            // system notification: once per unread stretch (reset on view)
            if (!unreadNotifiedRef.current.has(id)) {
              unreadNotifiedRef.current.add(id);
              const s = sessionsRef.current.find((x) => x.sessionId === id);
              const proj = projectNameRef.current.get(id);
              const who = s?.humanName ?? 'Ateam';
              notify(proj ? `${who} · ${proj}` : who, 'new message — output to review');
            }
            setUnread((u) => (u.has(id) ? u : new Set(u).add(id)));
          });
          const [hs, rc, sl, cfg, st] = await Promise.all([
            r.request('human.list', {}),
            r.request('project.recent', {}),
            r.request('session.list', {}),
            r.request('config.get', {}),
            r.request('sessionState.get', {}),
          ]);
          setHumans(hs.humans);
          setRecent(rc.dirs);
          setTree(sl.projects);
          setMachineName(cfg.config.machineName);
          setDesktopViewState(cfg.config.desktopView ?? 'terminal');
          const live = sl.projects.flatMap((p) => p.sessions);
          const now = Date.now();
          for (const s of live)
            if (!startedAtRef.current.has(s.sessionId)) startedAtRef.current.set(s.sessionId, now);
          // Land back on the session this device was last on — a phone
          // reopening its home-screen app (or self-healing a dropped socket)
          // used to be thrown to the first session in the tree every time.
          // Falls through to the first live session when the remembered one is
          // gone (desktop restarted, session closed).
          let remembered = '';
          try {
            remembered = localStorage.getItem(FOCUS_KEY) ?? '';
          } catch {
            /* private mode */
          }
          const landing = pickLandingSession(live, remembered);
          if (landing) setFocused(landing.sessionId);
          else if (cfg.firstRun) setSetup({ firstRun: true });
          else if (st.agents.length) {
            setRestorePrompt(st.agents);
            setRestoreFocus(st.focusedClaudeSessionId);
            setOriginalSavedAgents(st.agents);
            // default: every saved session is selected. User can uncheck.
            setRestorePicked(new Set(st.agents.map((a) => a.claudeSessionId)));
            setRestoreAuto(cfg.config.autoResume);
          }
        })
        .catch((e: unknown) => {
          if (!alive) return;
          const rec = reconnectRef.current;
          if (rec.tries > 0) {
            // mid-session reconnect failed → keep trying (or reload, above)
            rec.tries++;
            if (rec.tries > 6 && !('isTauri' in window)) {
              window.location.reload();
              return;
            }
            rec.timer = setTimeout(establish, Math.min(1000 * 2 ** rec.tries, 10_000));
            return;
          }
          setErr(e instanceof Error ? e.message : String(e));
        });
    };
    establish();
    // waking from lock / returning to the foreground → reconnect NOW
    const onVis = (): void => {
      if (document.visibilityState !== 'visible') return;
      const rec = reconnectRef.current;
      if (rec.tries === 0) return; // healthy
      if (rec.timer) clearTimeout(rec.timer);
      establish();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVis);
      if (reconnectRef.current.timer) clearTimeout(reconnectRef.current.timer);
    };
  }, [refresh, primeViewport]);

  // persist the open set + the currently-focused session to the shared
  // core cache (TUI + GUI share it). On next launch the GUI spawns the
  // focused one FIRST and starts you working immediately.
  //
  // We MERGE with `originalSavedAgents` (the snapshot of tui-state.json
  // at boot) so that sessions the user chose NOT to restore this time
  // (e.g. "Active only" picked 1 of 12) survive into next launch's
  // restore prompt instead of being clobbered to nothing. Dedupe by
  // claudeSessionId; current-live entries win when both exist (their
  // metadata is fresher).
  useEffect(() => {
    const r = rpcRef.current;
    if (!r || restoringRef.current) return;
    const agents = agentsToPersist(tree, originalSavedAgents);
    if (!agents.length) return;
    const focusedClaudeSessionId = tree
      .flatMap((p) => p.sessions)
      .find((s) => s.sessionId === focused)?.claudeSessionId;
    void r.request('sessionState.set', { agents, focusedClaudeSessionId }).catch(() => {});
  }, [tree, focused, originalSavedAgents]);

  // poll the tree every 5s so claude'\''s in-session title changes
  // (custom-title / agent-name / ai-title records) flow into the sidebar
  // without waiting for a status event — same cadence the TUI uses.
  useEffect(() => {
    if (!rpc) return;
    const t = setInterval(() => void refresh(rpc), 5000);
    return () => clearInterval(t);
  }, [rpc, refresh]);

  // Auto-handoff + token-bar poller. Every 15s:
  //   1. For EVERY live session, ask the sidecar for its token estimate.
  //      One session at a time: a burst would fill the sidecar's only
  //      thread, and the stream's session.transcript would wait behind it.
  //   2. For the focused session only: if estimate ≥ configured threshold
  //      AND auto-handoff is enabled AND we haven't already fired for
  //      this claudeSessionId, dispatch session.handoffNow. The backend's
  //      idle gate may reject (mid-turn) — in that case we DON'T mark as
  //      fired, so the next poll retries when the session goes quiet.
  //
  // Focus is read from a ref. Restarting this effect on every switch
  // re-read every transcript just as the new stream view asked for its
  // own, which is the long "loading transcript…" on a session change.
  const handoffFiredRef = useRef<Set<string>>(new Set());
  // sessions whose handoff the user has CONFIRMED (clicked "Start") — past
  // this point we retry handoffNow silently across ticks (no re-prompt) until
  // the backend's idle gate lets it through.
  const handoffConfirmedRef = useRef<Set<string>>(new Set());
  // per-session "ask again at" (claudeSessionId → absolute token count).
  // "Later" sets it to current usage + 5k so we re-ask only once the session
  // has grown another 5k from NOW (#12 — an offset on the threshold re-fired
  // immediately when usage was already past threshold+5k).
  const handoffSnoozeRef = useRef<Map<string, number>>(new Map());
  // live mirror of handoffInFlight for the auto-handoff tick: a handoff already
  // running (manual ✋ or a fired auto one, until session.replaced swaps the
  // node) must NOT pop the auto-handoff dialog — the session is still over
  // threshold but a handoff is already underway.
  const handoffInFlightRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    handoffInFlightRef.current = handoffInFlight;
  }, [handoffInFlight]);
  // Server-reported handoff state → local overlay. The client that TRIGGERED
  // the handoff marks it locally at request time; every OTHER client — a
  // phone connecting while the desktop's handoff is being written — learns
  // it here from session.list. Add-only: removal stays with the
  // session.replaced listener / the safety cap, so a poll racing the trigger
  // can't flicker the overlay off.
  useEffect(() => {
    for (const p of tree)
      for (const sess of p.sessions)
        if (sess.handoffInFlight && !handoffInFlightRef.current.has(sess.sessionId))
          markHandoffInFlight(sess.sessionId);
  }, [tree, markHandoffInFlight]);
  useEffect(() => {
    if (!rpc) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        // 1) poll all sessions for token estimate, one request at a time so a
        //    session switch's transcript can land between them
        const live = sessionsRef.current;
        const ests: (readonly [string, number])[] = [];
        for (const s of live) {
          if (cancelled) return;
          try {
            const e = await rpc.request('session.estimateTokens', {
              sessionId: s.sessionId,
            });
            ests.push([s.sessionId, e.tokens]);
          } catch {
            ests.push([s.sessionId, 0]);
          }
        }
        if (cancelled) return;
        setTokenEst(new Map(ests));
        // 2) auto-handoff check on whoever is focused now
        const focusedNow = focusedRef.current;
        if (!focusedNow) return;
        const sess = live.find((s) => s.sessionId === focusedNow);
        if (!sess) return;
        // a handoff is already running for this session → don't fire the
        // auto-handoff dialog (or a redundant handoffNow) on top of it.
        if (handoffInFlightRef.current.has(focusedNow)) return;
        const focusedTokens = ests.find(([id]) => id === focusedNow)?.[1] ?? 0;
        const cfg = await rpc.request('config.get', {});
        setTokenThreshold(cfg.config.autoHandoff.thresholdTokens);
        if (!cfg.config.autoHandoff.enabled) return;
        const thr = cfg.config.autoHandoff.thresholdTokens;
        const cid = sess.claudeSessionId;
        if (handoffFiredRef.current.has(cid)) return; // already handed off
        const effThr = effectiveThreshold(thr, handoffSnoozeRef.current.get(cid));
        if (focusedTokens < effThr) return; // below (postponed) threshold
        if (handoffConfirmedRef.current.has(cid)) {
          // user already confirmed — keep retrying past the idle gate, no
          // dialog, until the backend accepts.
          const r = await rpc.request('session.handoffNow', { sessionId: focusedNow });
          if (r.triggered) {
            handoffFiredRef.current.add(cid);
            markHandoffInFlight(focusedNow);
            setStatus(
              `auto-handoff queued @ ${focusedTokens.toLocaleString()} tokens (≥ ${effThr.toLocaleString()})`,
            );
          } else {
            setStatus(`auto-handoff waiting: ${r.reason ?? 'unknown'}`);
          }
          return;
        }
        // not confirmed yet → ask the user (once; keep an open prompt as-is)
        setHandoffPrompt((cur) =>
          cur && cur.claudeSessionId === cid
            ? cur
            : {
                sessionId: focusedNow,
                claudeSessionId: cid,
                source: 'auto',
                tokens: focusedTokens,
                threshold: effThr,
              },
        );
      } catch {
        /* transient — let next tick try again */
      }
    };
    const t = setInterval(() => void tick(), 15_000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [rpc, markHandoffInFlight]);

  // task.due → OS notification. The tasks pane highlights the row + refetches
  // off the same event; here we just raise the system notification.
  useEffect(() => {
    if (!rpc) return;
    return rpc.on('task.due', (d) => {
      notify('Task reminder', d.title || 'A task is due');
    });
  }, [rpc]);

  // All open tasks across every project, for the tree's per-project reminder
  // badge (g-task-badge below) — cheap (titles only) and live via the same
  // task.changed/task.due events the Tasks panel refetches on.
  useEffect(() => {
    if (!rpc) return;
    // seq guard: rapid task.changed events overlap two in-flight task.list
    // requests; if the older response lands LAST it overwrites the newer
    // snapshot and the tree badge sticks at a stale count until the next
    // event. Only the latest request may apply its result.
    let seq = 0;
    const load = (): void => {
      const mine = ++seq;
      void rpc
        .request('task.list', { status: 'open' })
        .then((r) => {
          if (mine === seq) setOpenTasks(r.tasks);
        })
        .catch(() => {});
    };
    load();
    const offs = [rpc.on('task.changed', load), rpc.on('task.due', load)];
    return () => {
      seq++; // invalidate any in-flight response after teardown
      for (const o of offs) o();
    };
  }, [rpc]);

  // projectId -> {count, due}, matched by the task's carried `project` (an
  // absolute cwd) against every session cwd currently in that project's
  // tree node — a project can span more than one workspace dir. `due` is
  // reminders whose remindAt has already passed (needs action NOW) — kept
  // separate from the plain count: "has open tasks" and "something is
  // overdue" are different signals, don't collapse them into one look.
  /** Parent folders of the projects you already work in — the natural
   *  candidates for "where should this new project live". Deduped, ordered
   *  by how many known projects sit under each. */
  const recentParents = useMemo(() => {
    const count = new Map<string, number>();
    for (const p of recent) {
      const parent = p.dir.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
      if (parent) count.set(parent, (count.get(parent) ?? 0) + 1);
    }
    return [...count.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([dir, n]) => ({ dir, source: `${n} project${n === 1 ? '' : 's'}` }));
  }, [recent]);

  const taskStatsByProject = useMemo(() => {
    const m = new Map<string, { count: number; due: number }>();
    if (openTasks.length === 0) return m;
    const projectIdByDir = new Map<string, string>();
    for (const p of tree) {
      for (const s of p.sessions) projectIdByDir.set(s.cwd, p.projectId);
    }
    const now = Date.now();
    for (const t of openTasks) {
      if (!t.project) continue;
      const pid = projectIdByDir.get(t.project);
      if (!pid) continue;
      const cur = m.get(pid) ?? { count: 0, due: 0 };
      cur.count += 1;
      if (t.remindAt !== undefined && t.remindAt <= now) cur.due += 1;
      m.set(pid, cur);
    }
    return m;
  }, [openTasks, tree]);

  /** The floating "you have things to do" bar over the stage.
   *
   *  Order matters more than the count here: whatever it points at is what a
   *  click acts on, so overdue reminders come first, then reminders by how
   *  soon, then plain tasks oldest-first. The COUNT is every open task,
   *  because that is the honest answer to "how much is waiting"; the TARGET
   *  is the first one that actually carries a creating session, since a task
   *  with no claudeSessionId has nowhere to jump to. Those two can disagree,
   *  and it is better that they do than to hide work from the count. */
  const taskNudge = useMemo(() => {
    if (openTasks.length === 0) return null;
    const now = Date.now();
    const rank = (t: TaskDTO): number => {
      if (t.remindAt !== undefined && t.remindAt <= now) return 0; // overdue
      if (t.remindAt !== undefined) return 1; // scheduled
      return 2;
    };
    const sorted = [...openTasks].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.remindAt ?? a.createdAt) - (b.remindAt ?? b.createdAt) ||
        a.createdAt - b.createdAt,
    );
    const target = sorted.find((t) => t.claudeSessionId) ?? null;
    const head = target ?? sorted[0];
    if (!head) return null;
    const nameByDir = new Map<string, string>();
    for (const p of tree) for (const x of p.sessions) nameByDir.set(x.cwd, p.alias ?? p.name);
    const label = head.project ? (nameByDir.get(head.project) ?? baseName(head.project)) : '';
    const others = new Set(openTasks.map((t) => t.project).filter((d) => d && d !== head.project))
      .size;
    const due = openTasks.filter((t) => t.remindAt !== undefined && t.remindAt <= now).length;
    return { count: openTasks.length, due, label, others, target };
  }, [openTasks, tree]);

  // session.replaced listener — swap focused to the successor and record
  // the predecessor so the Stage renders the dual-pane stack.
  useEffect(() => {
    if (!rpc) return;
    const off = rpc.on('session.replaced', (d) => {
      setPredecessorOf((m) => {
        const n = new Map(m);
        n.set(d.newSessionId, {
          oldId: d.oldSessionId,
          handoffPath: d.handoffPath,
          at: d.at,
        });
        return n;
      });
      // clear the in-flight flag for the old session (its Term un-locks
      // back to read-only-history mode in the dual stack).
      setHandoffInFlight((s) => {
        if (!s.has(d.oldSessionId)) return s;
        const n = new Set(s);
        n.delete(d.oldSessionId);
        return n;
      });
      // Forget the OLD claudeSessionId from the boot-time saved set so
      // the persist effect (which carries forward "remembered" entries)
      // doesn't keep resurrecting the retired session on every restart.
      // The successor will be persisted from the live tree.
      setOriginalSavedAgents((agents) =>
        agents.filter((a) => a.claudeSessionId !== d.oldClaudeSessionId),
      );
      // refresh tree so the new session appears, then auto-focus it
      void refresh(rpc).then(() => setFocused(d.newSessionId));
      setStatus(`context continued · new session active · ${d.handoffPath}`);
    });
    return () => off();
  }, [rpc, refresh]);

  // Esc leaves zoom
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const doRestore = useCallback(async () => {
    const r = rpcRef.current;
    const allSaved = restorePrompt;
    if (!r || !allSaved) return;
    primeViewport(); // restored sessions boot at the pane's real size
    // honor the per-row checkboxes — only spawn what the user picked.
    // empty set = nothing to do (same as "Start fresh"); handled below.
    const saved = allSaved.filter((a) => restorePicked.has(a.claudeSessionId));
    if (saved.length === 0) {
      setRestorePrompt(null);
      return;
    }
    const spawnArgs = (a: SessionStateAgent): Params<'session.spawn'> => ({
      projectName: a.projectName,
      agentName: a.agentName,
      role: a.role,
      ...(a.directoryless
        ? { directoryless: true }
        : { workspace: { id: `ws-${a.dir}`, name: a.projectName, root: a.dir } }),
      resumeSessionId: a.claudeSessionId,
      providerId: a.providerId,
    });

    // Priority (last-focused) first, then the rest by last-used desc (proxy:
    // saved-array order). Shared with the gray-placeholder render below.
    const ordered = orderForRestore(saved, restoreFocus);
    // Show ALL ordered rows as gray placeholders immediately, then dismiss
    // the prompt so the tree is visible during the sequential load.
    setRestoreQueue(ordered);
    setRestoreLoadedIds(new Set());
    setRestorePrompt(null);

    // STRICT sequential load. The key correctness point: session.spawn
    // RETURNS as soon as the PTY forks — claude hasn't booted or painted
    // its resumed conversation yet. Awaiting only the spawn would let all
    // N claude processes boot concurrently (the "都亮起来了 but no content"
    // bug). So after each spawn we WAIT until that session has actually
    // rendered meaningful output (lastOutputRef updated = claude painted
    // the resumed transcript) before starting the next. Only ONE claude
    // boots at a time → calm CPU/disk + every row truly has content when
    // it flips from gray to live. restoringRef suppresses the persist
    // effect so partial restores aren't written.
    const waitForRender = (sid: string, sinceMs: number): Promise<void> =>
      new Promise((resolve) => {
        const startedWait = Date.now();
        const tick = (): void => {
          const out = lastOutputRef.current.get(sid) ?? 0;
          // resolved when claude painted (output after spawn) OR a generous
          // 20s cap so one pathological session can't stall the whole queue
          // (big transcripts paint slowly; 20s is well past normal boot).
          if (out > sinceMs || Date.now() - startedWait > 20_000) {
            resolve();
            return;
          }
          setTimeout(tick, 150);
        };
        tick();
      });

    restoringRef.current = true;
    /** sessions that couldn't be booted, reported together once the queue drains */
    const skipped: string[] = [];
    // Hibernate-by-default: sessions with no conversation inside the
    // configured window (default 24h) are REGISTERED but not booted —
    // no ~300MB claude process for something nobody is talking to.
    // Clicking them in the tree wakes them via --resume.
    let hibernateCutoff = 0;
    try {
      const cfg = await r.request('config.get', {});
      if (cfg.config.hibernate.enabled) {
        hibernateCutoff = Date.now() - cfg.config.hibernate.idleHours * 3600_000;
      }
    } catch {
      /* config unavailable — boot everything, the old behavior */
    }
    const isStale = (a: SessionStateAgent): boolean => {
      if (!hibernateCutoff) return false;
      if (a.claudeSessionId === restoreFocus) return false; // last-focused always boots
      const last = a.lastActiveAt ? Date.parse(a.lastActiveAt) : Number.NaN;
      return Number.isFinite(last) && last < hibernateCutoff;
    };
    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i];
      if (!a) continue;
      // A conversation already running as a Claude Code background agent is not
      // ours to resume — it never stopped, and `--resume` refuses it. Register
      // the row and boot nothing, exactly like a hibernated one; clicking it
      // offers the forked copy.
      if (isStale(a) || a.backgroundAgent) {
        setBusy(
          `restoring · ${i + 1}/${ordered.length} · ${a.agentName} — ${
            a.backgroundAgent ? 'running in the background' : 'hibernated'
          }`,
        );
        try {
          await r.request('session.addHibernated', {
            projectName: a.projectName,
            agentName: a.agentName,
            role: a.role,
            dir: a.dir,
            claudeSessionId: a.claudeSessionId,
            directoryless: a.directoryless,
            providerId: a.providerId,
          });
        } catch {
          /* skip */
        }
        setRestoreLoadedIds((prev) => new Set(prev).add(a.claudeSessionId));
        await refresh(r).catch(() => {});
        continue;
      }
      setBusy(`restoring · ${i + 1}/${ordered.length} · ${a.agentName} — booting…`);
      const spawnAt = Date.now();
      let spawnedId = '';
      try {
        const res = await r.request('session.spawn', spawnArgs(a));
        spawnedId = res.session.sessionId;
        if (i === 0) setFocused(spawnedId); // priority focused immediately
      } catch (e) {
        // One un-restorable session must not block the queue — but it must not
        // vanish in silence either. A workspace directory that moved is the
        // usual cause, and without a word the session simply isn't there and
        // the user has no idea why.
        skipped.push(`${a.agentName}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (spawnedId) {
        // gray → live as soon as the row exists in the tree
        setRestoreLoadedIds((prev) => new Set(prev).add(a.claudeSessionId));
        await refresh(r).catch(() => {});
        // …then block here until claude has actually painted this one
        setBusy(`restoring · ${i + 1}/${ordered.length} · ${a.agentName} — rendering…`);
        await waitForRender(spawnedId, spawnAt);
      } else {
        setRestoreLoadedIds((prev) => new Set(prev).add(a.claudeSessionId));
      }
    }
    restoringRef.current = false;
    setBusy('');
    setRestoreQueue(null);
    setRestoreLoadedIds(new Set());
    if (skipped.length > 0) {
      setStatus(
        `couldn't restore ${skipped.length} session${skipped.length > 1 ? 's' : ''} — ${skipped
          .slice(0, 2)
          .join(' · ')}${skipped.length > 2 ? ' …' : ''}`,
      );
    }
  }, [restorePrompt, restoreFocus, restorePicked, refresh, primeViewport]);

  // autoResume: the prompt state is set on connect exactly as in the manual
  // flow; this effect presses "Restore" for the user. Flag first, then run —
  // a re-render mid-restore must not fire it twice.
  useEffect(() => {
    if (!restoreAuto || !restorePrompt) return;
    setRestoreAuto(false);
    void doRestore();
  }, [restoreAuto, restorePrompt, doRestore]);

  const reassignHuman = useCallback(
    async (sessionId: string, humanId: string) => {
      const r = rpcRef.current;
      if (!r) return;
      setReassignFor(null);
      try {
        await r.request('session.reassignHuman', { sessionId, humanId });
        await refresh(r);
      } catch (e) {
        setStatus(`reassign failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [refresh],
  );

  const reassignToNewHuman = useCallback(
    async (sessionId: string, name: string, role: string) => {
      const r = rpcRef.current;
      if (!r) return;
      setReassignFor(null);
      try {
        const created = await r.request('human.create', { name: name.trim(), role });
        await r.request('session.reassignHuman', {
          sessionId,
          humanId: created.human.id,
        });
        // refresh humans list too so the next picker sees the new human
        const hs = await r.request('human.list', {});
        setHumans(hs.humans);
        await refresh(r);
      } catch (e) {
        setStatus(`reassign failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [refresh],
  );

  /** Delete a session: kill its PTY, drop it from the backend map, AND
   *  forget it from tui-state.json (originalSavedAgents) so it doesn't
   *  resurrect on the next launch's restore prompt. */
  const deleteSession = useCallback(
    async (s: SessionNode) => {
      const r = rpcRef.current;
      if (!r) return;
      try {
        await r.request('session.delete', { sessionId: s.sessionId });
        setOriginalSavedAgents((agents) =>
          agents.filter((a) => a.claudeSessionId !== s.claudeSessionId),
        );
        if (focusedRef.current === s.sessionId) setFocused('');
        await refresh(r);
        setStatus(`deleted session · ${s.agentName}`);
      } catch (e) {
        setStatus(`delete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [refresh],
  );

  /** Recover an exited session: re-spawn claude with --resume on the same
   *  claudeSessionId, same human/project/dir, then drop the old exited
   *  tombstone. Lets the user get back a session they accidentally ended
   *  (e.g. double Ctrl-C) without losing the conversation. */
  const recoverSession = useCallback(
    async (s: SessionNode) => {
      const r = rpcRef.current;
      if (!r) return;
      setStatus(`recovering ${s.agentName}…`);
      try {
        const res = await r.request('session.spawn', {
          projectName:
            s.workspaceId === 'direct'
              ? undefined
              : tree.find((p) => p.projectId === s.projectId)?.name,
          agentName: s.agentName,
          role: s.role,
          human: { id: s.humanId, name: s.humanName, role: s.role },
          ...(s.workspaceId === 'direct'
            ? { directoryless: true }
            : { workspace: { id: s.workspaceId, name: s.sessionName, root: s.cwd } }),
          resumeSessionId: s.claudeSessionId,
          providerId: s.providerId,
        });
        // drop the old exited tombstone now that the resume is live
        await r.request('session.delete', { sessionId: s.sessionId }).catch(() => {});
        await refresh(r);
        setFocused(res.session.sessionId);
        setStatus(`recovered ${s.agentName}`);
      } catch (e) {
        setStatus(`recover failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [refresh, tree],
  );

  /** Open the New-session modal pre-filled to a specific project's
   *  workspace directory — the per-project ＋ shortcut in the tree. The
   *  user only has to pick the Human + role and hit Start. */
  const openNewForProject = useCallback((dir: string) => {
    setForm((f) => ({ ...f, dir }));
    setModal('new');
  }, []);

  /** New project: create (or adopt) the directory, then start its first
   *  session there. Creating the folder is the only part that can fail in a
   *  way the user must see — a failed mkdir must NOT fall through to a spawn
   *  in the wrong place, so we stop and report instead. */
  const createProject = useCallback(async () => {
    const r = rpcRef.current;
    if (!r) return;
    const picked = npHumanId ? humans.find((h) => h.id === npHumanId) : undefined;
    const name = picked?.name || npNewName.trim();
    const role = picked?.role || npRole.trim();
    if (!name || !role) {
      setBusy('Pick or name a teammate first');
      return;
    }
    setBusy('creating…');
    try {
      let dir: string;
      if (npMode === 'create') {
        const res = await r.request('path.createDir', { parent: npParent, name: npName });
        if (!res.dir) {
          setBusy(res.err ?? 'Could not create the directory');
          return;
        }
        dir = res.dir;
      } else {
        dir = npDir.trim();
        if (!dir) {
          setBusy('Pick an existing directory');
          return;
        }
        // the recent-projects list can outlive the folder itself; spawning
        // into a deleted cwd fails deep in node-pty with an opaque error.
        const found = await r
          .request('path.firstExisting', { paths: [dir] })
          .then((x) => x.path)
          .catch(() => null);
        if (!found) {
          setBusy('That directory no longer exists');
          return;
        }
        dir = found;
      }
      const projectName = baseName(dir);
      const res = await r.request('session.spawn', {
        projectName,
        agentName: name,
        role,
        human: npHumanId ? { id: npHumanId, name, role } : { name, role },
        workspace: { id: `ws-${dir}`, name: projectName, root: dir },
      });
      setModal('none');
      setBusy('');
      setNpName('');
      await refresh(r);
      setFocused(res.session.sessionId);
      setStatus(`project ready · ${dir}`);
    } catch (e) {
      setBusy(e instanceof Error ? e.message : String(e));
    }
  }, [npMode, npParent, npName, npDir, npHumanId, npNewName, npRole, humans, refresh]);

  /** Native folder pickers for the New-project modal (parent location for a
   *  fresh project, or the existing project folder itself). */
  const browseNpParent = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: 'Choose where to create the project',
      });
      if (typeof picked === 'string') setNpParent(picked);
    } catch (e) {
      setStatus(`folder picker failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);
  const browseNpDir = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: 'Choose an existing project folder',
      });
      if (typeof picked === 'string') setNpDir(picked);
    } catch (e) {
      setStatus(`folder picker failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  /** Native folder picker for the New-session workspace dir. Uses Tauri's
   *  dialog plugin (window dialog, not a webview prompt). Cancel → no-op. */
  const browseDir = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: 'Choose a workspace directory',
      });
      if (typeof picked === 'string') setForm((f) => ({ ...f, dir: picked }));
    } catch (e) {
      setStatus(`folder picker failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  /** a folder that is not among the recent ones: pick it from disk */
  const browseResumeDir = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: 'Choose the directory the session ran in',
      });
      if (typeof picked === 'string') setResumeDir(picked);
    } catch (e) {
      setStatus(`folder picker failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const spawn = useCallback(async () => {
    const r = rpcRef.current;
    if (!r) return;
    primeViewport();
    setBusy('starting…');
    try {
      const directoryless = form.dir.trim() === '';
      const name = (form.humanId && humans.find((h) => h.id === form.humanId)?.name) || form.name;
      const role = (form.humanId && humans.find((h) => h.id === form.humanId)?.role) || form.role;
      const projectName = directoryless ? name : baseName(form.dir);
      const res = await r.request('session.spawn', {
        projectName,
        agentName: name,
        role,
        providerId: form.providerId,
        human: form.humanId ? { id: form.humanId, name, role } : { name, role },
        ...(directoryless
          ? { directoryless: true }
          : { workspace: { id: `ws-${form.dir}`, name: projectName, root: form.dir } }),
      });
      setModal('none');
      setBusy('');
      await refresh(r);
      setFocused(res.session.sessionId);
    } catch (e) {
      setBusy(e instanceof Error ? e.message : String(e));
    }
  }, [form, humans, refresh, primeViewport]);

  // project.recent was read once, at connect. A project made since — a Claude
  // Desktop or terminal session started after Ateam did — was therefore in
  // none of the directory pickers until the next launch (the Resume dialog
  // "could not select" a directory that was number 4 in the backend's list).
  // Read it again whenever a dialog that picks a directory opens.
  useEffect(() => {
    const r = rpcRef.current;
    if (modal === 'none' || !r) return;
    let live = true;
    void r
      .request('project.recent', {})
      .then((rc) => {
        if (live) setRecent(rc.dirs);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [modal]);

  // No directory picked → list the chosen human's directory-less sessions
  // (they all ran on that human's desk); a directory lists that directory.
  const resumeDeskMode = !resumeDir.trim() && !!resumeHumanId;
  const openResume = useCallback(async () => {
    const r = rpcRef.current;
    if (!r) return;
    const dir = resumeDir.trim();
    if (!dir && !resumeHumanId) return;
    setBusy('loading…');
    try {
      const res = await r.request(
        'claude.sessions',
        dir ? { cwd: dir } : { humanId: resumeHumanId },
      );
      setResumeList(res.sessions);
      setBusy(res.sessions.length ? '' : 'no sessions found');
    } catch (e) {
      setBusy(e instanceof Error ? e.message : String(e));
    }
  }, [resumeDir, resumeHumanId]);

  const resumeOne = useCallback(
    async (c: ClaudeSessionInfo) => {
      const r = rpcRef.current;
      if (!r) return;
      setBusy('resuming…');
      try {
        const projectName = baseName(resumeDir);
        // A session already bound to a human (session-owners index) always
        // resumes as that human — resuming a known session must never
        // silently reassign it to whoever happens to be selected above.
        const owner = c.humanId ? humans.find((h) => h.id === c.humanId) : undefined;
        const picked =
          owner ?? (resumeHumanId ? humans.find((h) => h.id === resumeHumanId) : undefined);
        const name = picked?.name || resumeName;
        const role = picked?.role || resumeRole;
        const effectiveHumanId = owner?.id ?? resumeHumanId;
        const directoryless = !resumeDir.trim();
        const res = await r.request('session.spawn', {
          projectName: directoryless ? undefined : projectName,
          agentName: name,
          role,
          human: effectiveHumanId ? { id: effectiveHumanId, name, role } : { name, role },
          ...(directoryless
            ? { directoryless: true }
            : { workspace: { id: `ws-${resumeDir}`, name: projectName, root: resumeDir } }),
          resumeSessionId: c.id,
          providerId: c.providerId,
        });
        setModal('none');
        setBusy('');
        await refresh(r);
        setFocused(res.session.sessionId);
      } catch (e) {
        setBusy(e instanceof Error ? e.message : String(e));
      }
    },
    [resumeDir, resumeHumanId, resumeName, resumeRole, humans, refresh],
  );

  /** Task detail "跳转到发起会话": resolve where that conversation lives NOW
   *  (session.locate follows the auto-handoff successor chain) and either
   *  focus the live session (waking it if hibernated), resume it from disk
   *  as its recorded human, or say plainly why it's gone — never a silent
   *  no-op. Owner-unknown transcripts open the Resume picker prefilled on
   *  the task's project so the user chooses the human (never synthesized). */
  /** Land on the session a task came from, and say WHICH session that
   *  turned out to be — the id is what lets a caller then put the task's
   *  text into it. Existing callers ignore the return. */
  const jumpToTaskSession = useCallback(
    async (t: TaskDTO): Promise<string | undefined> => {
      const r = rpcRef.current;
      if (!r || !t.claudeSessionId) return undefined;
      try {
        const loc = await r.request('session.locate', {
          claudeSessionId: t.claudeSessionId,
          dir: t.project || undefined,
        });
        if (loc.kind === 'live') {
          select(loc.sessionId);
          return loc.sessionId;
        }
        if (loc.kind === 'resumable') {
          const owner = loc.humanId ? humans.find((h) => h.id === loc.humanId) : undefined;
          if (owner) {
            setStatus(`Restoring ${owner.name}'s session…`);
            const projectName = baseName(loc.dir);
            const res = await r.request('session.spawn', {
              projectName,
              agentName: owner.name,
              role: owner.role,
              human: { id: owner.id, name: owner.name, role: owner.role },
              workspace: { id: `ws-${loc.dir}`, name: projectName, root: loc.dir },
              resumeSessionId: loc.claudeSessionId,
            });
            await refresh(r);
            setFocused(res.session.sessionId);
            setStatus('');
            return res.session.sessionId;
          } else {
            setResumeDir(loc.dir);
            setModal('resume');
            setStatus(
              'This session has no human on record — pick one and restore it from the list',
            );
            const res = await r.request('claude.sessions', { cwd: loc.dir });
            setResumeList(res.sessions);
          }
          return undefined;
        }
        setStatus(`Cannot jump: ${loc.reason}`);
      } catch (e) {
        setStatus(`Jump failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return undefined;
    },
    [humans, refresh, select],
  );

  /** Jump to the task's session and put the task's text in it — typed, not
   *  sent. Same payload the Tasks panel's ▶ uses (body carries the paths and
   *  context; the title alone is too thin to act on), and the same rule: never
   *  press Enter for the user. They read it, edit it, then decide.
   *
   *  The wait is the tricky half. A LIVE session takes the text immediately,
   *  but a task can point at a session that has to be resumed first, and a
   *  claude that is still drawing its startup screen swallows anything typed
   *  into it. So for that path, hold until the PTY has actually said something
   *  (lastOutputRef ticks on every byte), then give it a beat to finish the
   *  frame. Capped, because a session that never boots must not leave the
   *  text in limbo with no explanation. */
  const openTaskInSession = useCallback(
    async (t: TaskDTO) => {
      const wasLive = sessionsRef.current.some(
        (x) => x.claudeSessionId === t.claudeSessionId && x.state !== 'exited',
      );
      const sessionId = await jumpToTaskSession(t);
      if (!sessionId) return;
      const r = rpcRef.current;
      if (!r) return;
      if (!wasLive) {
        setStatus('Waiting for the session to come up…');
        const deadline = Date.now() + 15000;
        const seenBefore = lastOutputRef.current.get(sessionId) ?? 0;
        while (Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 250));
          if ((lastOutputRef.current.get(sessionId) ?? 0) > seenBefore) break;
        }
        if ((lastOutputRef.current.get(sessionId) ?? 0) <= seenBefore) {
          setStatus('The session did not come up — task text not inserted');
          return;
        }
        await new Promise((res) => setTimeout(res, 900)); // let the frame settle
      }
      const data = t.body?.trim() || t.title;
      // Where the text has to land depends on how this session is being read.
      // In stream mode the composer is a React textarea; session.input would
      // put the task into the hidden terminal instead, where it is invisible
      // and waiting to corrupt whatever the user types there next.
      if (fillComposer(sessionId, data)) {
        setStatus(`Task ready to send: ${t.title}`);
        return;
      }
      await r
        .request('session.input', { sessionId, data })
        .then(() => setStatus(`Task ready to send: ${t.title}`))
        .catch((e) => setStatus(`Insert failed: ${e instanceof Error ? e.message : String(e)}`));
    },
    [jumpToTaskSession],
  );

  /** Fire session.handoffNow for the dialog's session with the picked
   *  successor runtime. Bypasses the threshold check, still honors the idle
   *  gate (won't disturb mid-stream). Auto-sourced prompts also mark the
   *  session confirmed so the poller retries past the idle gate silently. */
  const fireHandoff = useCallback(
    (p: NonNullable<typeof handoffPrompt>, providerId: ProviderId) => {
      const r = rpcRef.current;
      if (p.source === 'auto') handoffConfirmedRef.current.add(p.claudeSessionId);
      setHandoffPrompt(null);
      setHandoffCountdown(null);
      if (!r) return;
      setStatus('handoff requested…');
      void r
        .request('session.handoffNow', { sessionId: p.sessionId, successorProviderId: providerId })
        .then((res) => {
          if (res.triggered) {
            if (p.source === 'auto') handoffFiredRef.current.add(p.claudeSessionId);
            // Term renders the overlay + drops keyboard input. Cleared by the
            // session.replaced listener (or the safety cap inside markHandoffInFlight).
            markHandoffInFlight(p.sessionId);
            const hn =
              sessionsRef.current.find((x) => x.sessionId === p.sessionId)?.humanName ??
              'the session';
            setStatus(`handoff in flight · waiting for ${hn} to write the doc…`);
          } else if (p.source === 'auto') {
            // idle gate declined — the poller will retry silently (confirmed).
            setStatus(`handoff waiting (will retry): ${res.reason ?? 'unknown'}`);
          } else {
            setStatus(`handoff skipped: ${res.reason ?? 'unknown'}`);
          }
        })
        .catch((e) => setStatus(`handoff failed: ${e instanceof Error ? e.message : String(e)}`));
    },
    [markHandoffInFlight],
  );

  /** Same-runtime model changes need no successor: let the runtime show its
   * own always-current model picker and keep the exact conversation. */
  const openNativeModelPicker = useCallback((sessionId: string) => {
    const r = rpcRef.current;
    if (!r) return;
    setHandoffPrompt(null);
    setHandoffCountdown(null);
    setStatus("opening this runtime's model picker…");
    const providerId = sessionsRef.current.find((s) => s.sessionId === sessionId)?.providerId;
    void r
      .request('session.input', { sessionId, data: '/model' })
      .then(() => r.request('session.input', { sessionId, data: '\r' }))
      .then(async () => {
        // Cursor opens on Filter with no options; Down reveals the list so
        // Stream can render buttons (measured cursor-agent 2026.11.13).
        if (providerId !== 'cursor') return;
        await new Promise((resolve) => setTimeout(resolve, 400));
        await r.request('session.input', { sessionId, data: '\x1b[B' });
      })
      .catch((e) =>
        setStatus(`model picker failed: ${e instanceof Error ? e.message : String(e)}`),
      );
  }, []);

  /** Cross-runtime continuation is a cold switch: the source model is never
   * called. Core exports its on-disk transcript and starts the target model,
   * which reads that context as its first turn. */
  const switchProvider = useCallback(
    (p: NonNullable<typeof handoffPrompt>, providerId: ProviderId) => {
      const r = rpcRef.current;
      setHandoffPrompt(null);
      setHandoffCountdown(null);
      if (!r) return;
      const label = providers.find((x) => x.id === providerId)?.label ?? providerId;
      setStatus(`switching to ${label} · exporting local context…`);
      void r
        .request('session.switchProvider', {
          sessionId: p.sessionId,
          targetProviderId: providerId,
        })
        .then(async (res) => {
          await refresh(r);
          setFocused(res.session.sessionId);
          setStatus(`switched to ${label} · context inherited`);
        })
        .catch((e) => setStatus(`switch failed: ${e instanceof Error ? e.message : String(e)}`));
    },
    [providers, refresh],
  );

  /** Model/runtime switch for the focused session. Same runtime opens its own
   * model picker; another runtime cold-switches through the local transcript. */
  const doSwitchModel = useCallback(() => {
    const s = sessionsRef.current.find((x) => x.sessionId === focused);
    if (!s) return;
    const p = {
      sessionId: s.sessionId,
      claudeSessionId: s.claudeSessionId,
      source: 'switch' as const,
    };
    if (availableProviders.length <= 1) {
      openNativeModelPicker(s.sessionId);
      return;
    }
    setHandoffPrompt(p);
  }, [focused, availableProviders.length, openNativeModelPicker]);

  const doHandoffNow = useCallback(() => {
    const s = sessionsRef.current.find((x) => x.sessionId === focused);
    if (!s) return;
    const prompt = {
      sessionId: s.sessionId,
      claudeSessionId: s.claudeSessionId,
      source: 'manual' as const,
    };
    if (availableProviders.length <= 1) {
      fireHandoff(prompt, s.providerId ?? 'claude');
      return;
    }
    setHandoffPrompt(prompt);
  }, [focused, availableProviders.length, fireHandoff]);

  // Dialog lifecycle: when it opens, seed the runtime picker with the
  // session's own runtime and start the countdown; a tick reaching 0 fires
  // with whatever is selected. Any interaction with the dialog stops the
  // countdown — the user is deciding, don't yank the choice away from them.
  useEffect(() => {
    if (!handoffPrompt) return;
    const s = sessionsRef.current.find((x) => x.sessionId === handoffPrompt.sessionId);
    setHandoffProvider(s?.providerId ?? 'claude');
    setHandoffCountdown(handoffPrompt.source !== 'switch' ? HANDOFF_COUNTDOWN_S : null);
  }, [handoffPrompt]);
  useEffect(() => {
    if (!handoffPrompt || handoffCountdown === null) return;
    if (handoffCountdown <= 0) {
      fireHandoff(handoffPrompt, handoffProvider);
      return;
    }
    const t = setTimeout(() => setHandoffCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [handoffPrompt, handoffCountdown, handoffProvider, fireHandoff]);

  const stopHandoffCountdown = useCallback(() => setHandoffCountdown(null), []);

  const confirmHandoffPrompt = useCallback(() => {
    if (!handoffPrompt) return;
    if (handoffPrompt.source !== 'switch') {
      fireHandoff(handoffPrompt, handoffProvider);
      return;
    }
    const current = sessionsRef.current.find((s) => s.sessionId === handoffPrompt.sessionId);
    if ((current?.providerId ?? 'claude') === handoffProvider) {
      openNativeModelPicker(handoffPrompt.sessionId);
      return;
    }
    switchProvider(handoffPrompt, handoffProvider);
  }, [handoffPrompt, handoffProvider, fireHandoff, openNativeModelPicker, switchProvider]);

  // auto prompt: user clicked "Later" — ask again once the session has grown
  // another 5k from its CURRENT usage. manual prompt: plain cancel.
  const dismissHandoffPrompt = useCallback(() => {
    const p = handoffPrompt;
    if (!p) return;
    setHandoffPrompt(null);
    setHandoffCountdown(null);
    if (p.source !== 'auto') return;
    const askAgainAt = nextAskAt(p.tokens ?? 0);
    handoffSnoozeRef.current.set(p.claudeSessionId, askAgainAt);
    setStatus(`auto-handoff postponed · will ask again at ~${askAgainAt.toLocaleString()} tokens`);
  }, [handoffPrompt]);

  if (err) return <div className="fatal">⚠ {err}</div>;
  // reconnect overlay rides on top of the app instead of killing it
  if (!rpc || !treeReady || !bootFloorPassed)
    return (
      <div className="boot">
        <FoxWait size={96} />
        <span className="boot-dots">
          <span />
          <span />
          <span />
        </span>
        {/* Normally there is nothing worth saying here. But a boot that has
            hung is the one time the old "connecting to Ateam core…" line was
            worth its space, so it comes back after six seconds rather than
            being dropped along with the screen it lived on. */}
        {bootIsSlow && <span className="boot-note">connecting to Ateam core…</span>}
      </div>
    );

  if (setup) {
    return (
      <Setup
        rpc={rpc}
        firstRun={setup.firstRun}
        onDone={() => {
          setSetup(null);
          void rpc.request('human.list', {}).then((h) => setHumans(h.humans));
          void refresh(rpc);
        }}
      />
    );
  }

  if (restorePrompt && !restoreAuto) {
    const togglePicked = (id: string): void =>
      setRestorePicked((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
    const setAll = (mode: 'all' | 'active' | 'none'): void => {
      if (mode === 'all') {
        setRestorePicked(new Set(restorePrompt.map((a) => a.claudeSessionId)));
      } else if (mode === 'active') {
        setRestorePicked(new Set(restoreFocus ? [restoreFocus] : []));
      } else {
        setRestorePicked(new Set());
      }
    };
    const pickedCount = restorePicked.size;
    return (
      <div className="fatal">
        <div className="restore-card">
          <h3>Restore previous session set?</h3>
          <div className="muted small">
            {restorePrompt.length} saved from last time · pick which to restore. The priority
            (last-active) one spawns first; the rest load one at a time, shown grayed-out until each
            is ready.
          </div>
          <div className="restore-presets">
            <button type="button" onClick={() => setAll('all')}>
              All ({restorePrompt.length})
            </button>
            <button
              type="button"
              onClick={() => setAll('active')}
              disabled={!restoreFocus}
              title="Only spawn the last-active session — fastest path back to work"
            >
              Active only
            </button>
            <button type="button" onClick={() => setAll('none')}>
              None
            </button>
          </div>
          <ul className="restore-list">
            {restorePrompt.map((a) => {
              const isFocus = a.claudeSessionId === restoreFocus;
              const checked = restorePicked.has(a.claudeSessionId);
              return (
                <li key={a.claudeSessionId} className={`restore-item${isFocus ? ' is-focus' : ''}`}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePicked(a.claudeSessionId)}
                    />
                    <span className="restore-item-body">
                      {isFocus && <span className="restore-priority">▶ </span>}
                      <b>{a.agentName}</b> <span className="muted">[{a.role}]</span>{' '}
                      {a.providerId && a.providerId !== 'claude' && (
                        <span
                          className="resume-item-runtime"
                          title="Runtime that owns this session"
                        >
                          {providers.find((p) => p.id === a.providerId)?.label ?? a.providerId}
                        </span>
                      )}
                      <span className="muted small">
                        · {a.directoryless ? '(no directory)' : a.dir}
                        {isFocus ? ' · last active' : ''}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="row restore-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void doRestore()}
              disabled={pickedCount === 0}
              title={pickedCount === 0 ? 'Pick at least one session' : ''}
            >
              {pickedCount === restorePrompt.length
                ? `Restore all (${pickedCount})`
                : pickedCount === 0
                  ? 'Restore'
                  : `Restore ${pickedCount}`}
            </button>
            <button type="button" onClick={() => setRestorePrompt(null)}>
              Start fresh
            </button>
            <span className="muted">{busy}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-mobile={isMobile ? '1' : undefined}>
      <UpdateBanner />
      {reconnecting && (
        <div className="reconnect-toast wait-row">
          <FoxWait size={17} /> connecting…
        </div>
      )}
      <header className="bar">
        <button
          type="button"
          className={`bar-icon ${treeOpen ? 'on' : ''}`}
          onClick={toggleTree}
          title={treeOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          {IconSidebar}
        </button>
        <span className="brand">Ateam</span>
        {isMobile && machineName && (
          <span className="machine" title={`Connected to ${machineName}`}>
            {machineName}
          </span>
        )}
        {/* always mounted — its margin-left:auto is what right-aligns the toolbar */}
        <span className={`status${status ? ' has-msg' : ''}`} key={statusSeq}>
          {status}
        </span>
        <button
          type="button"
          className={focused && isStreamView(focused) ? 'on' : ''}
          onClick={() => focused && toggleStreamMode(focused)}
          disabled={!focused}
          title={
            focused && isStreamView(focused)
              ? 'Switch to the terminal'
              : 'Switch to the stream view (transcript-rendered chat — no terminal columns, reflows like a page)'
          }
        >
          {/* the icon names the DESTINATION: in the stream, it offers the terminal */}
          {focused && isStreamView(focused) ? IconTerminal : IconChat}
          {!isMobile && (focused && isStreamView(focused) ? 'Terminal' : 'Stream')}
        </button>
        <button
          type="button"
          onClick={doHandoffNow}
          disabled={!focused}
          title="Hand off the focused session to a fresh one — the current model writes a handoff document, then a successor takes over"
        >
          {IconHandoff}
          {!isMobile && 'Handoff'}
        </button>
        <button
          type="button"
          onClick={doSwitchModel}
          disabled={!focused}
          title="Switch model or runtime while keeping this session's context"
        >
          {IconSwap}
          {!isMobile && 'Switch model'}
        </button>
        <OpenWith rpc={rpc} defaultAppName={defaultAppName} setDefaultAppName={setDefaultAppName} />
        {relayMode && (
          <button
            type="button"
            className="bar-icon"
            onClick={switchMachine}
            title="Switch to another of your machines"
          >
            {IconSwap}
          </button>
        )}
        <button
          type="button"
          className={`bar-icon${chatOpen ? ' on' : ''}`}
          onClick={() => setChatOpen(true)}
          title="Team chat — talk to your teammates (chat mode)"
        >
          {IconTeamChat}
        </button>
        <LanButton rpc={rpc} relayMode={relayMode} onOpenSettings={() => setSettingsOpen(true)} />
        <button
          type="button"
          className={panelOpen ? 'on' : ''}
          onClick={() => setPanelOpen((v) => !v)}
        >
          {IconPanel}
          {!isMobile && 'Panel'}
        </button>
      </header>

      {!treeOpen && tree.length > 0 && (
        <div className="collapsed-nav">
          {tree.length > 1 && (
            <Dropdown
              className="collapsed-nav-proj"
              value={currentProject?.projectId ?? ''}
              // most-recently-active first: with a couple of dozen projects,
              // spawn order buries the one you were just in. The sidebar keeps
              // the tree's own order — this is the switcher's list only.
              options={projectsByRecency(tree).map((p) => ({
                value: p.projectId,
                label: p.alias ?? p.name,
                // the project's strongest live signal, same priority as a chip
                dot: projectStatus(p.sessions, {
                  focused,
                  pendingMenu,
                  unread,
                  tokenEst,
                  threshold: tokenThreshold,
                  lastOutput: lastOutputRef.current,
                  now: Date.now(),
                }),
              }))}
              onChange={(pid) => {
                setNavProjectId(pid);
                // Follow the project with the focus: land on its most recently
                // active session instead of leaving the user on the previous
                // project's terminal. select() handles a hibernated target
                // (it wakes it); navProjectId keeps the switcher pinned to the
                // new project meanwhile, so the async wake can't bounce it back.
                const target = lastActiveSessionId(
                  tree.find((p) => p.projectId === pid)?.sessions ?? [],
                );
                if (target) select(target);
              }}
              title="Switch project"
            />
          )}
          {(() => {
            // this project's open-task badge — same signal as the sidebar group
            const stats = currentProject
              ? taskStatsByProject.get(currentProject.projectId)
              : undefined;
            return stats && stats.count > 0 ? (
              <span
                className={`g-task-badge${stats.due ? ' due' : ''}`}
                title={
                  stats.due
                    ? `${stats.due} reminder(s) due · ${stats.count} open task(s)`
                    : `${stats.count} open task(s)`
                }
              >
                {stats.count}
              </span>
            ) : null;
          })()}
          <button
            type="button"
            className="cnav-new"
            title={
              currentProjectSessions[0]?.workspaceId !== 'direct' && currentProjectSessions[0]?.cwd
                ? `New session in ${currentProject?.name ?? 'this project'}`
                : 'New session'
            }
            onClick={() => {
              const first = currentProjectSessions[0];
              if (first && first.workspaceId !== 'direct') openNewForProject(first.cwd);
              else setModal('new');
            }}
          >
            {IconPlus}
          </button>
          {isMobile ? (
            /* phones: the chip strip is unusable at thumb width — one dropdown
               on the right, carrying each session's status dot */
            <Dropdown
              className="collapsed-nav-sess"
              value={focused}
              options={currentProjectSessions.map((s) => {
                const lastOut = lastOutputRef.current.get(s.sessionId) ?? 0;
                const busy = Date.now() - lastOut < 500 && s.state !== 'exited';
                const dot =
                  s.sessionId !== focused && pendingMenu.has(s.sessionId)
                    ? 'menu'
                    : (tokenEst.get(s.sessionId) ?? 0) >= tokenThreshold
                      ? 'limit'
                      : s.sessionId !== focused && unread.has(s.sessionId)
                        ? 'attn'
                        : busy
                          ? 'busy'
                          : undefined;
                return {
                  value: s.sessionId,
                  label: s.sessionName || s.humanName,
                  dot,
                  avatar: avatarSrc(humans.find((h) => h.id === s.humanId)?.avatarId),
                };
              })}
              onChange={select}
              title="Switch session"
              placeholder="session"
            />
          ) : (
            <div className="collapsed-nav-sessions">
              {currentProjectSessions.map((s) => {
                const human = humans.find((h) => h.id === s.humanId);
                // same live status signals the sidebar rows show
                const lastOut = lastOutputRef.current.get(s.sessionId) ?? 0;
                const busy = Date.now() - lastOut < 500 && s.state !== 'exited';
                const menuPending =
                  !busy && s.sessionId !== focused && pendingMenu.has(s.sessionId);
                const overLimit = (tokenEst.get(s.sessionId) ?? 0) >= tokenThreshold;
                const pending =
                  !busy && !menuPending && s.sessionId !== focused && unread.has(s.sessionId);
                return (
                  <div
                    key={s.sessionId}
                    className={`cnav-chip-wrap${s.sessionId === focused ? ' on' : ''}`}
                    onMouseEnter={(e) =>
                      setChipHover({
                        id: s.sessionId,
                        rect: e.currentTarget.getBoundingClientRect(),
                      })
                    }
                    onMouseLeave={() => setChipHover((h) => (h?.id === s.sessionId ? null : h))}
                  >
                    <button
                      type="button"
                      className={`cnav-chip${s.sessionId === focused ? ' on' : ''}`}
                      onClick={() => select(s.sessionId)}
                      title={`${s.sessionName} · ${s.humanName}`}
                    >
                      {/* same ring language as the sidebar rows: the state hugs
                      the face instead of riding beside it as a dot + spinner */}
                      <span className="cnav-ava-wrap">
                        <img className="cnav-ava" src={avatarSrc(human?.avatarId)} alt="" />
                        <span
                          className={`ava-ring ${
                            menuPending
                              ? 'menu'
                              : overLimit
                                ? 'limit'
                                : pending
                                  ? 'attn'
                                  : busy
                                    ? 'busy'
                                    : s.state
                          }`}
                          title={
                            menuPending
                              ? 'Waiting on a confirmation menu'
                              : overLimit
                                ? 'Context limit reached — hand off'
                                : pending
                                  ? "New output you haven't viewed"
                                  : busy
                                    ? `${s.humanName} is working…`
                                    : s.state
                          }
                        />
                      </span>
                      <span className="cnav-name">{s.sessionName}</span>
                    </button>
                    {/* the recover / delete actions float ABOVE the chip in a
                    portal (see chipHover) — inside the chip they covered its
                    own title, and the strip's horizontal scroll would clip
                    anything drawn outside the chip's box. */}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {chipHover &&
        (() => {
          const s = sessions.find((x) => x.sessionId === chipHover.id);
          if (!s) return null;
          const r = chipHover.rect;
          return createPortal(
            <div
              className="cnav-acts-pop"
              style={{ left: Math.round(r.left + r.width / 2), top: Math.round(r.top) }}
              // keep it open while the pointer travels from chip to buttons
              onMouseEnter={() => setChipHover({ id: s.sessionId, rect: r })}
              onMouseLeave={() => setChipHover(null)}
            >
              {(s.state === 'exited' || s.state === 'hibernated') && (
                <button
                  type="button"
                  className="row-act recover"
                  title={
                    s.state === 'exited'
                      ? 'Recover this session (resume the conversation)'
                      : 'Wake this hibernated session'
                  }
                  onClick={() => {
                    setChipHover(null);
                    if (s.state === 'exited') void recoverSession(s);
                    else {
                      setStatus(`waking ${s.sessionName}…`);
                      select(s.sessionId);
                    }
                  }}
                >
                  ↻
                </button>
              )}
              <button
                type="button"
                className="row-act delete"
                title="Delete this session"
                onClick={() => {
                  setChipHover(null);
                  setConfirmDelete(s);
                }}
              >
                {IconTrash}
              </button>
            </div>,
            document.body,
          );
        })()}

      <div className="body">
        {!zoom &&
          (() => {
            const renderRow = (s: SessionNode): JSX.Element => {
              // "ago" matches the ◉ filter: last real activity, not birth.
              // Birth (createdAt / first-seen) is only the fallback when the
              // session has never spoken — same rule as isActiveSession.
              const activity = sessionActivityMs({
                lastActiveAt: s.lastActiveAt,
                createdAt: s.createdAt,
                lastTurnMs: lastTurnRef.current.get(s.sessionId),
              });
              const agoAt =
                activity > 0
                  ? activity
                  : rowStarted(s.createdAt, startedAtRef.current.get(s.sessionId) ?? Date.now());
              const lastOut = lastOutputRef.current.get(s.sessionId) ?? 0;
              // STRICT: spinner only while claude is actively streaming
              // MEANINGFUL output (cosmetic redraws are filtered upstream so
              // they don't update lastOut). Window: chunk in last ~500ms.
              const busy = Date.now() - lastOut < 500 && s.state !== 'exited';
              // YELLOW DOT: claude is waiting on a permission menu the user
              // hasn't acted on. Higher priority than green because the work
              // is actually BLOCKED, not just unread.
              const menuPending = !busy && s.sessionId !== focused && pendingMenu.has(s.sessionId);
              // GREEN DOT: claude finished a response with content the user
              // hasn't viewed. select() clears it.
              const pending =
                !busy && !menuPending && s.sessionId !== focused && unread.has(s.sessionId);
              const inHumanView = groupBy === 'human';
              // human view: the group header already shows the human, so each
              // session row shows its OWN identity — session name + project dir.
              // project view: the project IS the group, so the human identity
              // (avatar + role badge) lives on the row instead.
              const dirTag = s.workspaceId === 'direct' ? '(no dir)' : baseName(s.cwd);
              const tipCtx = s.workspaceId === 'direct' ? '(no directory)' : baseName(s.cwd);
              const isReassigning = reassignFor === s.sessionId;
              // map session → human to resolve its avatar (falls back to the
              // neutral default when the human isn't loaded yet or has none)
              const human = humans.find((h) => h.id === s.humanId);
              // ONE status token drives both surfaces: the ring hugging the
              // avatar (project view) and the fallback dot (human view, whose
              // rows carry no avatar). Priority mirrors the old dot ladder:
              // blocked menu > context limit > unread > busy > plain state.
              const overLimit = (tokenEst.get(s.sessionId) ?? 0) >= tokenThreshold;
              const statusRing = menuPending
                ? 'menu'
                : overLimit
                  ? 'limit'
                  : pending
                    ? 'attn'
                    : busy
                      ? 'busy'
                      : s.state;
              const statusTitle = menuPending
                ? `${s.humanName} is waiting on a confirmation menu`
                : overLimit
                  ? 'Session has reached its context limit — hand off to a fresh one'
                  : pending
                    ? "New output you haven't viewed"
                    : busy
                      ? `${s.humanName} is working…`
                      : s.state;
              return (
                <div
                  key={s.sessionId}
                  className={`row${inHumanView ? ' row-human' : ''}${s.sessionId === focused ? ' on' : ''}${s.state === 'hibernated' ? ' zzz' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => select(s.sessionId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      select(s.sessionId);
                    }
                  }}
                  title={`${s.humanName} · ${tipCtx} · ${s.role}`}
                >
                  {/* Status lives on the avatar's ring (see .ava-ring). The
                    standalone dot survives only for the human view, whose
                    rows carry no avatar to hug. */}
                  {inHumanView && <span className={`dot ${statusRing}`} title={statusTitle} />}
                  {!inHumanView && (
                    <button
                      type="button"
                      className="row-avatar-wrap"
                      title={`${s.humanName} [${s.role}] · click to change human`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setReassignFor(isReassigning ? null : s.sessionId);
                      }}
                    >
                      <img
                        className="row-avatar"
                        src={avatarSrc(human?.avatarId)}
                        alt=""
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = avatarSrc(undefined);
                        }}
                      />
                      <span className={`ava-ring ${statusRing}`} title={statusTitle} />
                    </button>
                  )}
                  {inHumanView ? (
                    // human view: the header owns the person, so the row owns
                    // the session — name on its own line, project underneath.
                    // Same two-line stack as project view, so switching tabs
                    // keeps the same vertical rhythm.
                    <span className="row-2line">
                      <span className="row-2line-main">{s.sessionName || 'session'}</span>
                      <span className="row-2line-sub">
                        {IconFolderSm}
                        {dirTag}
                      </span>
                    </span>
                  ) : (
                    // project view: two-line stack right of the avatar —
                    // big = session name, small = human name.
                    <span className="row-2line">
                      <span className="row-2line-main">
                        {s.sessionName || s.humanName || 'session'}
                      </span>
                      <span className="row-2line-sub">
                        {s.humanName}
                        {s.role ? ` · ${s.role}` : ''}
                      </span>
                    </span>
                  )}
                  {/* busy no longer needs its own glyph here — the avatar's
                    ring sweeps while claude streams. Human view has no avatar,
                    so it keeps the small spinner. */}
                  {busy && inHumanView && (
                    <span className="spinner-petal" title={`${s.humanName} is working…`} />
                  )}
                  <span className="row-right muted">
                    {s.state === 'exited' && (
                      <button
                        type="button"
                        className="row-act recover"
                        title="Recover this session (resume the conversation)"
                        onClick={(e) => {
                          e.stopPropagation();
                          void recoverSession(s);
                        }}
                      >
                        ↻
                      </button>
                    )}
                    <button
                      type="button"
                      className="row-act delete"
                      title="Delete this session"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(s);
                      }}
                    >
                      {IconTrash}
                    </button>
                    {!busy && <span className="row-ago">{timeAgo(agoAt)}</span>}
                  </span>
                  {/* per-session token bar moved to the right Panel's
                    Status tab (sidebar rows stay quiet by default). */}
                  {isReassigning && (
                    <ReassignPop
                      currentHumanId={s.humanId}
                      humans={humans}
                      onPick={(hid) => void reassignHuman(s.sessionId, hid)}
                      onCreate={(name, role) => void reassignToNewHuman(s.sessionId, name, role)}
                      onClose={() => setReassignFor(null)}
                    />
                  )}
                </div>
              );
            };
            // Gray, NON-CLICKABLE placeholder for a saved session that hasn't
            // spawned yet (no onClick / onKeyDown / role / tabIndex → it can't
            // be selected). Flips to the real live row once its spawn finishes.
            const renderPlaceholder = (a: SessionStateAgent): JSX.Element => (
              <div className="row placeholder" key={a.claudeSessionId}>
                <span className="dot loading" />
                <span className="row-title">{a.agentName || a.projectName || 'session'}</span>
                {a.role && <span className="row-role">{a.role}</span>}
                <span className="row-tag">{a.directoryless ? '(no dir)' : baseName(a.dir)}</span>
              </div>
            );
            return (
              <div
                className={`side-slide${treeDragging ? ' no-anim' : ''}`}
                style={{ width: treeOpen ? treeWidth : 0 }}
              >
                <aside
                  className={`tree${treeNarrow ? ' narrow' : ''}`}
                  style={{ width: treeWidth }}
                >
                  <div className="tree-tool">
                    <button
                      type="button"
                      className="tool-btn"
                      onClick={() => {
                        setBusy(''); // don't inherit the other modal's error line
                        setModal('new');
                      }}
                    >
                      <span className="tool-icon">{IconPlus}</span> New session
                    </button>
                    <button
                      type="button"
                      className="tool-btn"
                      onClick={() => {
                        setBusy('');
                        setModal('newProject');
                      }}
                    >
                      <span className="tool-icon">{IconFolderPlus}</span> New project
                    </button>
                    <button type="button" className="tool-btn" onClick={() => setModal('resume')}>
                      <span className="tool-icon">{IconResume}</span> Resume
                    </button>
                  </div>

                  <div className="tree-group-toggle">
                    <button
                      type="button"
                      className={groupBy === 'project' ? 'on' : ''}
                      onClick={() => setGroupBy('project')}
                      title="Group sessions by project"
                    >
                      Projects
                    </button>
                    <button
                      type="button"
                      className={groupBy === 'human' ? 'on' : ''}
                      onClick={() => setGroupBy('human')}
                      title="Group sessions by human"
                    >
                      Humans
                    </button>
                    <button
                      type="button"
                      className={`active-filter${activeOnly ? ' on' : ''}`}
                      onClick={toggleActiveOnly}
                      title={`Show only sessions with new messages in the last ${activeWindowLabel(activeWindowH)}, and hide the rest. Change the window in Settings → General (24h / 3d / 7d / 15d).`}
                    >
                      ◉ {activeWindowLabel(activeWindowH)}
                    </button>
                  </div>

                  <div className="tree-search">
                    <input
                      type="search"
                      value={treeQuery}
                      placeholder="Search sessions or projects"
                      spellCheck={false}
                      onChange={(e) => setTreeQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setTreeQuery('');
                      }}
                    />
                  </div>

                  <div className="tree-body">
                    {shownGroups.map((g) => (
                      <div key={g.key} className="group">
                        <div
                          className="g-head"
                          role="button"
                          tabIndex={0}
                          title={!searching && collapsedGroups.has(g.key) ? 'Expand' : 'Collapse'}
                          onClick={() => toggleGroup(g.key)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggleGroup(g.key);
                            }
                          }}
                        >
                          <span className="g-twirl">
                            {!searching && collapsedGroups.has(g.key) ? '▸' : '▾'}
                          </span>
                          {groupBy === 'human' ? (
                            (() => {
                              const gh = humans.find((h) => h.id === g.key);
                              return (
                                <>
                                  <img
                                    className="g-avatar"
                                    src={avatarSrc(gh?.avatarId)}
                                    alt=""
                                    onError={(e) => {
                                      (e.target as HTMLImageElement).src = avatarSrc(undefined);
                                    }}
                                  />
                                  <span className="g-name">{g.name}</span>
                                  {gh?.role && <span className="g-role">{gh.role}</span>}
                                </>
                              );
                            })()
                          ) : (
                            <>
                              <span className="g-icon">{IconFolder}</span>
                              {renamingProject?.key === g.key ? (
                                <input
                                  className="g-rename"
                                  // biome-ignore lint/a11y/noAutofocus: inline rename field, opened by an explicit click
                                  autoFocus
                                  value={renamingProject.value}
                                  placeholder={g.name}
                                  onClick={(e) => e.stopPropagation()} // don't toggle the group
                                  onChange={(e) =>
                                    setRenamingProject({ key: g.key, value: e.target.value })
                                  }
                                  onBlur={() => void commitProjectAlias()}
                                  onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') void commitProjectAlias();
                                    else if (e.key === 'Escape') setRenamingProject(null);
                                  }}
                                />
                              ) : (
                                <>
                                  <span className="g-name" title={g.alias ? g.name : undefined}>
                                    {g.alias ?? g.name}
                                  </span>
                                  <button
                                    type="button"
                                    className="g-act rename"
                                    title={
                                      g.alias
                                        ? `Rename (real folder: ${g.name}) — display only`
                                        : 'Give this project a display alias'
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setRenamingProject({ key: g.key, value: g.alias ?? '' });
                                    }}
                                  >
                                    {IconPencil}
                                  </button>
                                </>
                              )}
                              {(() => {
                                const stats = taskStatsByProject.get(g.key);
                                if (!stats || stats.count === 0) return null;
                                const due = stats.due > 0;
                                return (
                                  <span
                                    className={`g-task-badge${due ? ' due' : ''}`}
                                    title={
                                      due
                                        ? `${stats.due} reminder(s) due · ${stats.count} open task(s)`
                                        : `${stats.count} open task(s)`
                                    }
                                  >
                                    {stats.count}
                                  </span>
                                );
                              })()}
                            </>
                          )}
                          {!searching &&
                            collapsedGroups.has(g.key) &&
                            (() => {
                              // collapsed rows hide their sessions' dots — bubble
                              // the strongest one up to the header (same ladder as
                              // the rows and the collapsed-nav project switcher).
                              const dot = projectStatus(g.sessions, {
                                focused,
                                pendingMenu,
                                unread,
                                tokenEst,
                                threshold: tokenThreshold,
                                lastOutput: lastOutputRef.current,
                                now: Date.now(),
                              });
                              if (!dot) return null;
                              const titles = {
                                menu: 'A session inside is waiting on a confirmation menu',
                                limit: 'A session inside hit the context limit — hand off',
                                attn: "A session inside has new output you haven't viewed",
                                busy: 'A session inside is working',
                              } as const;
                              return <span className={`dot ${dot} g-dot`} title={titles[dot]} />;
                            })()}
                          {groupBy === 'project' && g.dir && (
                            <button
                              type="button"
                              className="g-add"
                              title={`New session in ${g.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                openNewForProject(g.dir as string);
                              }}
                            >
                              ＋
                            </button>
                          )}
                        </div>
                        {(searching || !collapsedGroups.has(g.key)) && (
                          <div className="g-rows">{g.sessions.map(renderRow)}</div>
                        )}
                      </div>
                    ))}
                    {shownChats.length > 0 && (
                      <>
                        <div className="section-label">Chats</div>
                        <div className="chats-section">{shownChats.map(renderRow)}</div>
                      </>
                    )}
                    {/* Still restoring — kept BELOW the sessions that are already up.
                  On top, this block shrinks as each session lands and shoves
                  the usable rows down the list under the cursor; at the bottom
                  the loaded ones simply accumulate where they are. */}
                    {pendingAgents.length > 0 && (
                      <>
                        <div className="section-label wait-row">
                          <FoxWait size={16} /> Loading…
                        </div>
                        <div className="loading-section">
                          {pendingAgents.map(renderPlaceholder)}
                        </div>
                      </>
                    )}
                    {searching && shownGroups.length === 0 && shownChats.length === 0 && (
                      <div className="muted pad">
                        No session or project matches “{treeQuery.trim()}”
                      </div>
                    )}
                    {!searching &&
                      groups.length === 0 &&
                      chatSessions.length === 0 &&
                      pendingAgents.length === 0 && <div className="muted pad">no sessions</div>}
                  </div>

                  <div className="tree-bottom">
                    <button type="button" className="tool-btn" onClick={() => setMarketOpen(true)}>
                      <span className="tool-icon">{IconMarket}</span> Market
                    </button>
                    <button
                      type="button"
                      className="tool-btn"
                      onClick={() => setSettingsOpen(true)}
                    >
                      <span className="tool-icon">{IconGear}</span> Settings
                    </button>
                  </div>

                  <div
                    className="tree-resizer"
                    onMouseDown={onResizeStart}
                    title="Drag to resize"
                  />
                </aside>
              </div>
            );
          })()}

        {/* Single-pane stage. After an auto-handoff we simply focus the
            successor (see the session.replaced handler) — its first message
            IS the handoff doc, so scrolling up shows the takeover context.
            One continuous conversation, no split screen. */}
        <main className="stage" ref={stageRef}>
          {/* Floating nudge: what is waiting, and one click to start on it.
              Lives over the stage rather than in the top bar because the bar
              is already full and this is transient — it is gone the moment
              the list empties. */}
          {taskNudge && (
            <button
              type="button"
              className={`task-nudge${taskNudge.due > 0 ? ' due' : ''}`}
              title={
                taskNudge.target
                  ? `Open "${taskNudge.target.title}" in its session — the text is typed in for you, not sent`
                  : 'These tasks have no originating session recorded'
              }
              disabled={!taskNudge.target}
              onClick={() => {
                if (taskNudge.target) void openTaskInSession(taskNudge.target);
              }}
            >
              {IconCheck}
              <span className="task-nudge-n">{taskNudge.count}</span>
              <span className="task-nudge-txt">
                {taskNudge.count === 1 ? 'task' : 'tasks'}
                {taskNudge.label && ` · ${taskNudge.label}`}
                {taskNudge.others > 0 && ` +${taskNudge.others}`}
              </span>
            </button>
          )}
          {focused &&
            (() => {
              // Same source/formula the Panel status tab uses — kept in sync
              // by reading from the same tokenEst/tokenThreshold, not a copy.
              const thr = tokenThreshold ?? 120_000;
              const tk = tokenEst.get(focused) ?? 0;
              const pct = Math.min(100, Math.max(0, (tk / thr) * 100));
              const tone = pct < 50 ? 'lo' : pct < 80 ? 'ok' : pct < 95 ? 'warn' : 'danger';
              return (
                <div
                  className="stage-ctx-bar"
                  title={`Context: ${tk.toLocaleString()} / ${thr.toLocaleString()} tokens · ${pct.toFixed(1)}%`}
                >
                  <span className={`stage-ctx-fill ${tone}`} style={{ width: `${pct}%` }} />
                </div>
              );
            })()}
          {sessions.map((s) => (
            <Term
              key={s.sessionId}
              sessionId={s.sessionId}
              rpc={rpc}
              active={s.sessionId === focused && !isStreamView(s.sessionId)}
              cwd={s.cwd}
              onOpenPath={openPath}
              onUserInput={engage}
              pendingHandoff={handoffInFlight.has(s.sessionId)}
              humanName={s.humanName}
            />
          ))}
          {/* stream view mounts only while chosen — history is one cheap
              RPC away, unlike the terminal which must keep xterm hot */}
          {focused && isStreamView(focused) && (
            <StreamView
              key={`sv-${focused}`}
              rpc={rpc}
              sessionId={focused}
              active
              cwd={sessions.find((s) => s.sessionId === focused)?.cwd}
              pendingHandoff={handoffInFlight.has(focused)}
              humanName={sessions.find((s) => s.sessionId === focused)?.humanName}
              model={sessions.find((s) => s.sessionId === focused)?.model}
              providerId={sessions.find((s) => s.sessionId === focused)?.providerId}
              onUserInput={engage}
              onOpenPath={openPath}
              avatarOfSession={avatarOfSession}
              peerMentions={peerMentions}
            />
          )}
          {focused && !isStreamView(focused) && (
            <ExternalRunFeed
              key={`external-${focused}`}
              rpc={rpc}
              sessionId={focused}
              variant="terminal"
            />
          )}
          {sessions.length === 0 && <div className="muted center">No active session.</div>}
          {/* NOT in stream mode: the key bar's relay input forwards keys to
              the PTY — in the stream view that means typing into an invisible
              terminal while its own composer sits covered underneath the bar
              (the "can't type anything" report). Stream brings its own
              composer; the bar and its terminal keys belong to the terminal. */}
          {isMobile && focused && !isStreamView(focused) && (
            <MobileKeys rpc={rpc} sessionId={focused} onSent={() => engage(focused)} />
          )}
          {/* drawers open over the terminal on phones — tap outside closes them */}
          {isMobile && (treeOpen || panelOpen) && (
            <div
              className="m-backdrop"
              onClick={() => {
                if (treeOpen) toggleTree();
                if (panelOpen) setPanelOpen(false);
              }}
            />
          )}
        </main>

        {lastFv && (
          <div
            className={`side-slide fv-slide${fvDragging ? ' no-anim' : ''}`}
            style={{ width: fileView ? fvOpenWidth : 0 }}
          >
            {!isMobile && (
              <div className="fv-resizer" onMouseDown={onFvResizeStart} title="Drag to resize" />
            )}
            <FileView
              rpc={rpc}
              dir={lastFv.dir}
              file={lastFv.file}
              openToken={lastFv.token}
              gotoLine={lastFv.line}
              width={fvOpenWidth}
              onOpenExternal={openWithSystem}
              onOpenUnsupported={openWithSystem}
              onClose={closeFileView}
            />
          </div>
        )}

        {!zoom &&
          (() => {
            const focusedSession = sessions.find((s) => s.sessionId === focused);
            const focusedProject = focusedSession
              ? tree.find((p) => p.projectId === focusedSession.projectId)
              : undefined;
            const projectName = focusedProject?.alias ?? focusedProject?.name;
            return (
              <div className="side-slide" style={{ width: panelOpen ? 332 : 0 }}>
                <Panel
                  rpc={rpc}
                  session={focusedSession}
                  onOpenPath={openPath}
                  tokens={focused ? tokenEst.get(focused) : undefined}
                  tokenThreshold={tokenThreshold}
                  startedAt={
                    // real session lifetime start (transcript birthtime), NOT
                    // when this GUI run first saw it — same rule as tree rows
                    focusedSession
                      ? rowStarted(
                          focusedSession.createdAt,
                          startedAtRef.current.get(focusedSession.sessionId) ?? Date.now(),
                        )
                      : undefined
                  }
                  lastOutputAt={focused ? lastTurnRef.current.get(focused) : undefined}
                  projectName={projectName}
                  onJumpTaskSession={jumpToTaskSession}
                />
              </div>
            );
          })()}
      </div>

      {modal === 'new' && (
        <div className="modal-bg" onClick={() => setModal('none')}>
          <div
            className="modal modal-new-session"
            ref={modalRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ns-head">
              <span className="ns-mark">{IconPlus}</span>
              <div className="ns-head-text">
                <h3>New session</h3>
                <p className="ns-sub">Choose a teammate and a workspace, then start.</p>
              </div>
            </div>

            <div className="ns-fields">
              <div className="ns-field">
                <span className="ns-label">Teammate</span>
                <HumanPicker
                  value={form.humanId}
                  humans={humans}
                  onChange={(id) => setForm({ ...form, humanId: id })}
                />
              </div>
              {!form.humanId && (
                <div className="ns-field-pair">
                  <label className="ns-field">
                    <span className="ns-label">Name</span>
                    <input
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  </label>
                  <div className="ns-field">
                    <span className="ns-label">Role</span>
                    <RolePicker value={form.role} onChange={(v) => setForm({ ...form, role: v })} />
                  </div>
                </div>
              )}
              <div className="ns-field">
                <span className="ns-label">Workspace</span>
                <DirPicker
                  value={form.dir}
                  recent={recent}
                  onChange={(dir) => setForm({ ...form, dir })}
                  onBrowse={() => void browseDir()}
                  noneLabel="◇ no directory · talk to this human"
                />
              </div>
              {availableProviders.length > 1 && (
                <div className="ns-field">
                  <span className="ns-label">Runtime</span>
                  <Dropdown
                    value={form.providerId}
                    options={availableProviders.map((p) => ({ value: p.id, label: p.label }))}
                    onChange={(v) => setForm({ ...form, providerId: v as ProviderId })}
                    title="Which agent CLI drives this session"
                  />
                </div>
              )}
            </div>

            <div className="ns-foot">
              <div className="ns-foot-actions">
                <button type="button" className="ns-start" onClick={spawn}>
                  Start session
                </button>
                <button type="button" className="ns-cancel" onClick={() => setModal('none')}>
                  Cancel
                </button>
              </div>
              {busy && (
                <div
                  className={'ns-status ' + (busy.endsWith('…') ? 'is-working' : 'is-error')}
                  role="status"
                >
                  <span className="ns-status-dot" />
                  <span className="ns-status-text">{busy}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {modal === 'newProject' && (
        <div className="modal-bg" onClick={() => setModal('none')}>
          <div
            className="modal modal-new-session"
            ref={modalRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ns-head">
              <span className="ns-mark">{IconPlus}</span>
              <div className="ns-head-text">
                <h3>New project</h3>
                <p className="ns-sub">
                  Create a folder or adopt an existing one, then start its first session.
                </p>
              </div>
            </div>

            <div className="ns-fields">
              <div className="ns-field">
                <span className="ns-label">Location</span>
                <div className="np-seg">
                  <button
                    type="button"
                    className={`np-seg-btn${npMode === 'create' ? ' is-sel' : ''}`}
                    onClick={() => setNpMode('create')}
                  >
                    New directory
                  </button>
                  <button
                    type="button"
                    className={`np-seg-btn${npMode === 'existing' ? ' is-sel' : ''}`}
                    onClick={() => setNpMode('existing')}
                  >
                    Use existing directory
                  </button>
                </div>
              </div>

              {npMode === 'create' ? (
                <>
                  <div className="ns-field">
                    <span className="ns-label">Parent folder</span>
                    <DirPicker
                      value={npParent}
                      recent={recentParents}
                      onChange={setNpParent}
                      onBrowse={() => void browseNpParent()}
                      noneLabel="◇ Choose a parent directory…"
                    />
                  </div>
                  <label className="ns-field">
                    <span className="ns-label">Project name</span>
                    <input
                      value={npName}
                      placeholder="my-app"
                      onChange={(e) => setNpName(e.target.value)}
                    />
                  </label>
                  {npParent && npName.trim() && (
                    <div className="np-preview mono" title={`${npParent}/${npName.trim()}`}>
                      {`${npParent.replace(/\/+$/, '')}/${npName.trim()}`}
                    </div>
                  )}
                </>
              ) : (
                <div className="ns-field">
                  <span className="ns-label">Project folder</span>
                  <DirPicker
                    value={npDir}
                    recent={recent}
                    onChange={setNpDir}
                    onBrowse={() => void browseNpDir()}
                    noneLabel="◇ Choose the project directory…"
                  />
                </div>
              )}

              <div className="ns-field">
                <span className="ns-label">Teammate</span>
                <HumanPicker value={npHumanId} humans={humans} onChange={setNpHumanId} />
              </div>
              {!npHumanId && (
                <div className="ns-field-pair">
                  <label className="ns-field">
                    <span className="ns-label">Name</span>
                    <input value={npNewName} onChange={(e) => setNpNewName(e.target.value)} />
                  </label>
                  <div className="ns-field">
                    <span className="ns-label">Role</span>
                    <RolePicker value={npRole} onChange={setNpRole} />
                  </div>
                </div>
              )}
            </div>

            <div className="ns-foot">
              <div className="ns-foot-actions">
                <button
                  type="button"
                  className="ns-start"
                  disabled={npMode === 'create' ? !npParent || !npName.trim() : !npDir}
                  onClick={createProject}
                >
                  Create project
                </button>
                <button type="button" className="ns-cancel" onClick={() => setModal('none')}>
                  Cancel
                </button>
              </div>
              {busy && (
                <div
                  className={'ns-status ' + (busy.endsWith('…') ? 'is-working' : 'is-error')}
                  role="status"
                >
                  <span className="ns-status-dot" />
                  <span className="ns-status-text">{busy}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {modal === 'resume' && (
        <div className="modal-bg" onClick={() => setModal('none')}>
          <div className="modal" ref={modalRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <h3>Resume a session</h3>
            <div className="ns-field resume-dir-field">
              <span className="ns-label">Human</span>
              <HumanPicker value={resumeHumanId} humans={humans} onChange={setResumeHumanId} />
            </div>
            {!resumeHumanId && (
              <div className="ns-field-pair">
                <label className="ns-field resume-dir-field">
                  <span className="ns-label">Name</span>
                  <input value={resumeName} onChange={(e) => setResumeName(e.target.value)} />
                </label>
                <div className="ns-field resume-dir-field">
                  <span className="ns-label">Role</span>
                  <RolePicker value={resumeRole} onChange={setResumeRole} />
                </div>
              </div>
            )}
            <div className="ns-field resume-dir-field">
              <span className="ns-label">Directory</span>
              <DirPicker
                value={resumeDir}
                recent={recent}
                onChange={setResumeDir}
                onBrowse={() => void browseResumeDir()}
                noneLabel="— no directory —"
              />
              {!resumeDir.trim() && (
                <span className="muted resume-hint">
                  {resumeHumanId
                    ? "No directory: lists this human's directory-less sessions."
                    : 'Pick a directory, or a human to list their directory-less sessions.'}
                </span>
              )}
            </div>
            <div className="row">
              <button
                type="button"
                onClick={openResume}
                disabled={!resumeDir.trim() && !resumeHumanId}
                title={resumeDeskMode ? 'List directory-less sessions' : 'List sessions'}
              >
                List sessions
              </button>
              <button type="button" onClick={() => setModal('none')}>
                Cancel
              </button>
              <span className="muted">{busy}</span>
            </div>
            <div className="resume-list">
              {resumeList.map((c) => {
                const owner = c.humanId ? humans.find((h) => h.id === c.humanId) : undefined;
                return (
                  <button
                    type="button"
                    key={c.id}
                    className="resume-item"
                    onClick={() => resumeOne(c)}
                  >
                    {owner && (
                      <img
                        className="resume-item-avatar"
                        src={avatarSrc(owner.avatarId)}
                        alt=""
                        title={`${owner.name} · resumes as this human`}
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = avatarSrc(undefined);
                        }}
                      />
                    )}
                    <span className="resume-item-text">
                      {c.providerId && c.providerId !== 'claude' && (
                        <span
                          className="resume-item-runtime"
                          title="Runtime that owns this session"
                        >
                          {providers.find((p) => p.id === c.providerId)?.label ?? c.providerId}
                        </span>
                      )}
                      <b>{c.title || c.summary || '(untitled)'}</b>
                      <span className="muted">
                        {' '}
                        {c.title && c.summary && c.summary !== c.title ? `— ${c.summary} ` : ''}
                        {c.mtime ? c.mtime.slice(0, 16).replace('T', ' ') : ''} · {c.id.slice(0, 8)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <McpApproval rpc={rpc} />
      {settingsOpen && (
        <Settings
          rpc={rpc}
          onClose={() => {
            setSettingsOpen(false);
            // an avatar / name / role may have changed in Settings — refresh
            // the humans list so the tree + person cards show the new value
            // immediately (avatar is resolved from this `humans` state).
            const r = rpcRef.current;
            if (r) void r.request('human.list', {}).then((h) => setHumans(h.humans));
          }}
          theme={theme}
          setTheme={setTheme}
          desktopView={desktopView}
          setDesktopView={setDesktopView}
          activeWindowH={activeWindowH}
          setActiveWindowH={setActiveWindow}
        />
      )}

      {chatOpen && (
        <ChatView
          rpc={rpc}
          humans={humans}
          recent={recent.map((r) => ({ dir: r.dir, source: r.source }))}
          onOpenPath={openWithSystem}
          onHumansChanged={() => {
            const r = rpcRef.current;
            if (r) void r.request('human.list', {}).then((h) => setHumans(h.humans));
          }}
          onClose={() => setChatOpen(false)}
        />
      )}
      {marketOpen && (
        <Market
          rpc={rpc}
          onClose={() => {
            setMarketOpen(false);
            // hiring a prefab created new Humans — refresh so the tree + person
            // cards reflect the new teammates immediately.
            const r = rpcRef.current;
            if (r) void r.request('human.list', {}).then((h) => setHumans(h.humans));
          }}
        />
      )}

      {handoffPrompt && (
        <div className="modal-bg" onClick={dismissHandoffPrompt}>
          <div
            className="modal handoff-confirm"
            onClick={(e) => e.stopPropagation()}
            // any interaction with the dialog means the user is deciding —
            // stop the auto-start clock (it only exists for unattended sessions)
            onPointerDownCapture={stopHandoffCountdown}
            onKeyDownCapture={stopHandoffCountdown}
          >
            <h3 className="wait-row">
              {handoffPrompt.source !== 'switch' ? IconHandoff : IconSwap}{' '}
              {handoffPrompt.source !== 'switch'
                ? 'Hand off this session?'
                : 'Switch model or runtime'}
            </h3>
            <p className="handoff-confirm-body">
              {handoffPrompt.source === 'auto' ? (
                <>
                  This session is at <strong>{(handoffPrompt.tokens ?? 0).toLocaleString()}</strong>{' '}
                  estimated tokens (threshold {(handoffPrompt.threshold ?? 0).toLocaleString()}).
                  Hand it off now and a fresh session takes over where this one left off — or keep
                  going and decide later.
                </>
              ) : handoffPrompt.source === 'manual' ? (
                <>
                  A fresh session takes over where this one left off — the current session writes a
                  handoff doc first, then the successor picks it up.
                </>
              ) : (
                <>
                  Staying on the same runtime opens its own model picker and keeps the exact
                  conversation. Switching runtime starts the target model with a local export of
                  this conversation; the current model is not called, so this works even when its
                  quota is exhausted.
                </>
              )}
            </p>
            {availableProviders.length > 1 && (
              <div className="handoff-confirm-runtime">
                <span className="ns-label">
                  {handoffPrompt.source !== 'switch' ? 'Successor runtime' : 'Continue with'}
                </span>
                <Dropdown
                  value={handoffProvider}
                  options={availableProviders.map((p) => ({ value: p.id, label: p.label }))}
                  onChange={(v) => setHandoffProvider(v as ProviderId)}
                  title="Which agent CLI drives the successor session"
                />
              </div>
            )}
            <div className="handoff-confirm-actions">
              <button type="button" className="primary" onClick={confirmHandoffPrompt}>
                {handoffPrompt.source !== 'switch'
                  ? 'Start handoff'
                  : (sessions.find((s) => s.sessionId === handoffPrompt.sessionId)?.providerId ??
                        'claude') === handoffProvider
                    ? 'Choose model'
                    : `Switch to ${providers.find((p) => p.id === handoffProvider)?.label ?? handoffProvider}`}
                {handoffPrompt.source !== 'switch' && handoffCountdown !== null && (
                  <span className="handoff-countdown" key={handoffCountdown}>
                    {handoffCountdown}s
                  </span>
                )}
              </button>
              <button type="button" onClick={dismissHandoffPrompt}>
                {handoffPrompt.source === 'auto' ? 'Later (+5k)' : 'Cancel'}
              </button>
              {handoffCountdown !== null && (
                <span
                  className="handoff-countdown-bar"
                  style={{ animationDuration: `${HANDOFF_COUNTDOWN_S}s` }}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {staleMcpProjects.length > 0 && (
        <div className="modal-bg" onClick={() => setStaleMcpProjects([])}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>MCP project access skipped</h3>
            <p className="muted">
              External MCP clients (ChatGPT / Claude) were granted access to{' '}
              {staleMcpProjects.length === 1 ? 'a folder' : 'folders'} that no longer{' '}
              {staleMcpProjects.length === 1 ? 'exists' : 'exist'}. They are ignored; everything
              else works as before.
            </p>
            <ul className="mono">
              {staleMcpProjects.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <div className="row">
              <button type="button" className="primary" onClick={() => setStaleMcpProjects([])}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {forkPrompt && (
        <div className="modal-bg" onClick={() => setForkPrompt(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>This conversation is running in the background</h3>
            <p className="muted">
              Claude Code has it open as a <b>background agent</b>, so it never stopped and cannot
              be resumed here. Attach to the running one with{' '}
              <code className="mono">claude agents</code> in a terminal — or open a{' '}
              <b>forked copy</b> here, which starts from the same history and runs alongside it.
            </p>
            <div className="row">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const id = forkPrompt;
                  setForkPrompt(null);
                  const r = rpcRef.current;
                  if (!r || !id) return;
                  setStatus('opening a forked copy…');
                  void r
                    .request('session.wake', { sessionId: id, fork: true })
                    .then(async (res) => {
                      await refreshRef.current?.(r);
                      setFocused(res.session.sessionId);
                      setStatus('forked copy opened — the background agent keeps running');
                    })
                    .catch((e) =>
                      setStatus(`fork failed: ${e instanceof Error ? e.message : String(e)}`),
                    );
                }}
              >
                Open a forked copy
              </button>
              <button type="button" onClick={() => setForkPrompt(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {pathPick && (
        <div className="modal-bg" onClick={() => setPathPick(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Which {pathPick.ref}?</h3>
            <p className="muted">
              This session has touched more than one file by that name. Pick the one you meant:
            </p>
            <div className="pathpick-list">
              {pathPick.candidates.map((c) => (
                <button
                  type="button"
                  key={c}
                  className="pathpick-item"
                  onClick={() => {
                    const line = pathPick.line;
                    setPathPick(null);
                    openResolved(c, line);
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="row">
              <button type="button" onClick={() => setPathPick(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-bg" onClick={() => setConfirmDelete(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete session?</h3>
            <p className="muted">
              <b>{confirmDelete.sessionName || confirmDelete.humanName}</b>
              {confirmDelete.workspaceId !== 'direct' && <> · {baseName(confirmDelete.cwd)}</>}
              <br />
              This ends the session and removes it from the list. The conversation transcript on
              disk is kept — you can still resume it from Resume later.
            </p>
            <div className="row">
              <button
                type="button"
                className="danger"
                onClick={() => {
                  const s = confirmDelete;
                  setConfirmDelete(null);
                  void deleteSession(s);
                }}
              >
                Delete
              </button>
              <button type="button" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
