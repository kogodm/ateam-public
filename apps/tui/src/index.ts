#!/usr/bin/env tsx
/**
 * Ateam — first-version TUI session multiplexer (split view).
 *
 * Left = project -> agent tree. Right = the selected agent's real `claude`
 * session, rendered through an embedded terminal emulator so you talk to it
 * directly. Tab / clicks switch focus; Ctrl-] returns focus to the tree.
 *
 * - New-agent form can resume an existing Claude Code session (claude --resume).
 * - A non-focused session that produced output then went quiet (needs a
 *   permission answer / finished) gets a red attention dot in the tree.
 *
 * Talks to core ONLY over @ateam/contract (embedded inproc Port) so Tauri
 * reuses the same backend unchanged.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import type {
  ClaudeSessionInfo,
  ExperienceHit,
  GrowthReport,
  HumanDTO,
  ProjectTree,
  SessionNode,
  SkillUnitDTO,
  WorkspaceInfoDTO,
} from '@ateam/contract';
import {
  RpcClient,
  type SavedAgent,
  SessionManager,
  createServer,
  loadSessionState,
  saveSessionState,
} from '@ateam/core';
import { createInprocPair } from '@ateam/transport';
import stringWidth from 'string-width';

const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless');
type Terminal = import('@xterm/headless').Terminal;

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const CYAN = `${ESC}[36m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const REV = `${ESC}[7m`;
const SHOW = `${ESC}[?25h`;
const HIDE = `${ESC}[?25l`;
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1000l${ESC}[?1006l`;
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
const at = (r: number, c: number): string => `${ESC}[${r};${c}H`;
const out = (s: string): void => void process.stdout.write(s);

const ACTIVE_MS = 600; // output within this window => claude is processing
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const spinFrame = (): string => SPIN[Math.floor(Date.now() / 80) % SPIN.length] ?? '⠋';

// --- embedded core over the contract ---
const sessions = new SessionManager();
const server = createServer({ sessions });
const { client: clientPort, server: serverPort } = createInprocPair();
server.attach(serverPort);
const rpc = new RpcClient(clientPort);

// --- layout ---
let COLS = process.stdout.columns ?? 100;
let ROWS = process.stdout.rows ?? 30;
let LW = 28;
let RW = 60;
let SW = 0; // right sidebar width (0 = hidden)
let H = 28;
let sidebar = false;
const BODY_TOP = 2;
function computeLayout(): void {
  COLS = process.stdout.columns ?? 100;
  ROWS = process.stdout.rows ?? 30;
  LW = Math.max(22, Math.min(40, Math.floor(COLS * 0.3)));
  SW = sidebar ? Math.max(24, Math.min(46, Math.floor(COLS * 0.24))) : 0;
  RW = Math.max(20, COLS - LW - 1 - (SW ? SW + 1 : 0));
  H = Math.max(5, ROWS - 2);
}

// --- state ---
type Mode = 'split' | 'prompt' | 'menu' | 'resume' | 'growth' | 'setup' | 'zoom';
let mode: Mode = 'split';
let statusMsg = ''; // transient note shown in the footer (manual reflect, …)
let metaStatus = ''; // autonomous flywheel progress (footer segment)
let metaAt = 0;
const growthCache = new Map<string, GrowthReport>(); // role -> growth
let growthHumanId = '';
let growthHumanLabel = '';
let focus: 'tree' | 'term' = 'tree';
let tree: ProjectTree[] = [];
let flat: SessionNode[] = [];
let cursor = 0;
let focusedId: string | null = null;
const projectIds = new Map<string, string>();
const terms = new Map<string, Terminal>();
const scrollOff = new Map<string, number>(); // sessionId -> lines scrolled up from live
const wsCache = new Map<string, WorkspaceInfoDTO>(); // cwd -> git/tree info
let wsFetchAt = 0;
let rowMap: (number | undefined)[] = [];
let dirty = true;
let mouseOn = true; // SGR mouse capture; released in term focus for native select
let lastTreeAt = 0; // throttle periodic tree refresh (picks up /name renames)

/** Mouse stays captured in split (tree click + wheel-scroll the claude
 *  pane). Released ONLY in `z` zoom, where the screen is pure claude text
 *  so native drag-select/copy grabs exactly that. Idempotent. */
function applyMouseMode(): void {
  const want = mode !== 'zoom';
  if (want === mouseOn) return;
  mouseOn = want;
  out(want ? MOUSE_ON : MOUSE_OFF);
}

interface Meta {
  /** ms of the last output chunk (drives the processing spinner) */
  last: number;
  /** has ever produced output */
  had: boolean;
  /** new output the user has not viewed yet (drives the `*`) */
  unread: boolean;
}
const meta = new Map<string, Meta>();
function getMeta(id: string): Meta {
  let m = meta.get(id);
  if (!m) {
    m = { last: 0, had: false, unread: false };
    meta.set(id, m);
  }
  return m;
}
/** The user is now viewing this session -> its output is read. */
function markRead(id: string | null): void {
  if (!id) return;
  getMeta(id).unread = false;
}

function termFor(id: string): Terminal {
  let t = terms.get(id);
  if (!t) {
    t = new Terminal({ cols: RW, rows: H, allowProposedApi: true, scrollback: 5000 });
    terms.set(id, t);
    void rpc.request('session.resize', { sessionId: id, cols: RW, rows: H });
  }
  return t;
}

rpc.on<{ sessionId: string; chunk: string }>('session.output', (d) => {
  termFor(d.sessionId).write(d.chunk);
  const m = getMeta(d.sessionId);
  m.last = Date.now();
  m.had = true;
  if (d.sessionId !== focusedId) m.unread = true; // produced output you can't see
  dirty = true;
});
rpc.on('session.status', () => void refresh());
function setMeta(s: string): void {
  metaStatus = s;
  metaAt = Date.now();
  dirty = true;
}
rpc.on<{ agentKey: string; title: string; domain: string }>('evolution.experience', (d) => {
  void refreshGrowth(d.agentKey);
  setMeta(`✦ learned: ${d.title} [${d.domain}]`);
});
rpc.on<{ agentKey: string; count: number }>('evolution.skill', (d) => {
  void refreshGrowth(d.agentKey);
  setMeta(`✦ distilled ${d.count} skill`);
});
rpc.on<{ phase: string; detail: string }>('meta.progress', (d) => {
  const label =
    d.phase === 'reflect'
      ? `⟳ auto-reflect ${d.detail}`
      : d.phase === 'distill'
        ? `⚗ distill ${d.detail}`
        : d.phase === 'decay'
          ? '↓ decay'
          : `✦ evolved ${d.detail}`;
  setMeta(label);
});

async function refreshGrowth(humanId: string): Promise<void> {
  if (!humanId) return;
  try {
    const g = await rpc.request<GrowthReport>('agent.growth', { agentKey: humanId });
    growthCache.set(humanId, g);
    dirty = true;
  } catch {
    /* ignore */
  }
}

function expertiseSummary(humanId: string): string {
  const g = growthCache.get(humanId);
  if (!g || g.totalExperiences === 0) return '';
  const top = g.domains[0];
  return top
    ? ` ${DIM}· 📈 ${top.domain} ${top.level} (${g.totalExperiences}exp)${RESET}`
    : ` ${DIM}· 📈 ${g.totalExperiences}exp${RESET}`;
}

async function reflectFocused(): Promise<void> {
  const s = flat.find((x) => x.sessionId === focusedId);
  if (!s) return;
  statusMsg = `⟳ reflecting ${s.agentName}… (claude)`;
  dirty = true;
  try {
    const r = await rpc.request<{ saved: boolean; experience?: ExperienceHit }>(
      'flywheel.reflect',
      { sessionId: s.sessionId },
    );
    statusMsg = r.saved
      ? `✓ learned: ${r.experience?.title ?? ''} [${r.experience?.domain ?? ''}]`
      : '· nothing worth reflecting yet';
    if (r.saved) await refreshGrowth(s.humanId);
  } catch (e) {
    statusMsg = `reflect failed: ${(e as Error).message}`;
  }
  dirty = true;
}

function renderGrowth(): void {
  const g = growthCache.get(growthHumanId);
  let s = `${ESC}[2J${at(1, 1)}${SHOW}`;
  s += `${BOLD}成长档案${RESET} ${DIM}· human: ${growthHumanLabel} · ${RESET}${BOLD}Esc${RESET}${DIM} back${RESET}\r\n`;
  s += `${DIM}─────────────────────────────────────────────${RESET}\r\n`;
  if (!g || g.totalExperiences === 0) {
    s += `${DIM}  (no experience yet — run reflect (R) after a task)${RESET}\r\n`;
  } else {
    s += `  ${BOLD}${g.totalExperiences}${RESET} experiences\r\n\r\n`;
    s += `  ${DIM}domain            level        n   appl  conf${RESET}\r\n`;
    for (const d of g.domains) {
      s += `  ${d.domain.padEnd(16).slice(0, 16)}  ${d.level.padEnd(11)}  ${String(d.count).padStart(2)}  ${String(d.applied).padStart(4)}  ${d.avgConfidence.toFixed(2)}\r\n`;
    }
    s += `\r\n  ${DIM}recent${RESET}\r\n`;
    for (const r of g.recent) {
      s += `  ${DIM}${r.createdAt.slice(0, 10)}${RESET} ${r.title} ${DIM}[${r.domain}] ×${r.appliedCount}${RESET}\r\n`;
    }
  }
  out(s);
}

function openGrowth(): void {
  const s = flat.find((x) => x.sessionId === focusedId);
  growthHumanId = s?.humanId ?? '';
  growthHumanLabel = s ? `${s.humanName} [${s.role}]` : '(none)';
  mode = 'growth';
  void refreshGrowth(growthHumanId).then(renderGrowth);
  renderGrowth();
}

function onGrowthKey(data: string): void {
  if (data === '\x1b' || data === 'q' || data === '\x03' || data === 'g') {
    mode = 'split';
    out(`${ESC}[2J`);
    dirty = true;
  }
}

// --- persistence: offer to reopen last session set on launch ---
// Persistence lives in @ateam/core (shared with the desktop GUI via the
// sessionState.* RPC) so both front-ends restore the SAME ~/.ateam cache.
let restoring = false;
let savedAgents: SavedAgent[] = [];

function saveState(): void {
  if (restoring) return;
  // never clobber a good saved set with an empty one (e.g. user skipped)
  if (flat.length === 0) return;
  const agents: SavedAgent[] = [];
  for (const p of tree)
    for (const s of p.sessions) {
      if (s.state === 'exited') continue;
      agents.push({
        projectName: p.name,
        agentName: s.agentName,
        role: s.role,
        dir: s.cwd,
        claudeSessionId: s.claudeSessionId,
        directoryless: s.workspaceId === 'direct',
      });
    }
  saveSessionState(agents);
}

function renderResume(): void {
  let s = `${ESC}[2J${at(1, 1)}${SHOW}`;
  s += `${BOLD}Restore previous session?${RESET} ${DIM}(${savedAgents.length} agents · `;
  s += `${RESET}${BOLD}Enter${RESET}${DIM} restore · ${RESET}${BOLD}Esc${RESET}${DIM} clean start)${RESET}\r\n`;
  s += `${DIM}─────────────────────────────────────────────${RESET}\r\n`;
  savedAgents.forEach((a) => {
    s += `  ${DIM}▸${RESET} ${a.agentName} ${DIM}[${a.role}] · ${a.projectName} · ${a.dir}${RESET}\r\n`;
  });
  out(s);
}

async function doRestore(): Promise<void> {
  restoring = true;
  // First open after upgrade: pull skills out of every dir each human has
  // worked in, into their vault (server marker-guards this to run once).
  // Awaited so restored sessions already recall the newly-adopted skills.
  try {
    await rpc.request('skill.adoptHumanDirs', { all: true });
  } catch {
    /* best-effort backfill */
  }
  for (const a of savedAgents) {
    try {
      const known = projectIds.get(a.projectName);
      const res = await rpc.request<{ session: SessionNode }>('session.spawn', {
        projectId: known,
        projectName: a.projectName,
        agentName: a.agentName,
        role: a.role,
        ...(a.directoryless
          ? { directoryless: true }
          : { workspace: { id: `ws-${a.dir}`, name: a.projectName, root: a.dir } }),
        resumeSessionId: a.claudeSessionId,
        cols: RW,
        rows: H,
      });
      projectIds.set(a.projectName, res.session.projectId);
      termFor(res.session.sessionId); // create the xterm now, sized RW x H
    } catch {
      /* skip an un-restorable agent (dir gone / session lost) */
    }
  }
  restoring = false;
  mode = 'split';
  out(`${ESC}[2J`);
  await refresh();
  renderSplit();
}

async function leaveResume(restore: boolean): Promise<void> {
  if (restore && savedAgents.length > 0) {
    out(`${ESC}[2J${at(1, 1)}${DIM} restoring…${RESET}`);
    await doRestore();
  } else {
    mode = 'split';
    out(`${ESC}[2J`);
    await refresh();
    renderSplit();
  }
}

function onResumeKey(data: string): void {
  if (data === '\r' || data === '\n' || data === 'y') {
    void leaveResume(true);
  } else if (data === '\x1b' || data === 'n' || data === 'q' || data === '\x03') {
    void leaveResume(false);
  }
}

async function refresh(): Promise<void> {
  const res = await rpc.request<{ projects: ProjectTree[] }>('session.list');
  tree = res.projects;
  flat = tree.flatMap((p) => p.sessions);
  if (cursor >= flat.length) cursor = Math.max(0, flat.length - 1);
  const cur = flat[cursor];
  if (!focusedId && cur) {
    focusedId = cur.sessionId;
    markRead(focusedId);
  }
  saveState();
  dirty = true;
}

/** Cut a string to at most `max` DISPLAY columns (CJK = 2 cols each). */
function cutCols(s: string, max: number): { text: string; width: number } {
  let w = 0;
  let res = '';
  for (const ch of s) {
    const cw = stringWidth(ch) || 1;
    if (w + cw > max) break;
    res += ch;
    w += cw;
  }
  return { text: res, width: w };
}
/** Pad/truncate to exactly `cols` display columns (width-aware). */
function padCols(s: string, cols: number): string {
  const { text, width } = cutCols(s, cols);
  return text + ' '.repeat(Math.max(0, cols - width));
}

type XLine = import('@xterm/headless').IBufferLine;
type XCell = import('@xterm/headless').IBufferCell;

function sgrCodes(c: XCell): string {
  const p: number[] = [];
  if (c.isInverse()) p.push(7);
  if (c.isBold()) p.push(1);
  if (c.isDim()) p.push(2);
  if (c.isItalic()) p.push(3);
  if (c.isUnderline()) p.push(4);
  if (c.isStrikethrough()) p.push(9);
  if (c.isFgPalette()) {
    const f = c.getFgColor();
    if (f < 8) p.push(30 + f);
    else if (f < 16) p.push(90 + (f - 8));
    else p.push(38, 5, f);
  } else if (c.isFgRGB()) {
    const v = c.getFgColor();
    p.push(38, 2, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  }
  if (c.isBgPalette()) {
    const b = c.getBgColor();
    if (b < 8) p.push(40 + b);
    else if (b < 16) p.push(100 + (b - 8));
    else p.push(48, 5, b);
  } else if (c.isBgRGB()) {
    const v = c.getBgColor();
    p.push(48, 2, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  }
  return p.length ? `${ESC}[${p.join(';')}m` : '';
}

function cellSig(c: XCell): string {
  return (
    `${c.isInverse()}${c.isBold()}${c.isDim()}${c.isItalic()}${c.isUnderline()}${c.isStrikethrough()}` +
    `|${c.isFgRGB()}${c.isFgPalette()}:${c.getFgColor()}|${c.isBgRGB()}${c.isBgPalette()}:${c.getBgColor()}`
  );
}

/** Serialize one xterm line to ANSI (color + attributes), clamped to maxCols. */
function lineToAnsi(line: XLine | undefined, maxCols: number): string {
  if (!line) return '';
  let res = '';
  let w = 0;
  let lastSig: string | undefined;
  for (let x = 0; x < line.length && w < maxCols; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    const cw = cell.getWidth();
    if (cw === 0) continue; // trailing half of a wide char
    if (w + cw > maxCols) break;
    const sig = cellSig(cell);
    if (sig !== lastSig) {
      res += `${ESC}[0m${sgrCodes(cell)}`;
      lastSig = sig;
    }
    const ch = cell.getChars();
    res += ch === '' ? ' ' : ch;
    w += cw;
  }
  return `${res}${ESC}[0m`;
}

interface TreeLine {
  plain: string;
  idx?: number;
}
function treeLines(): TreeLine[] {
  const lines: TreeLine[] = [];
  if (flat.length === 0) lines.push({ plain: ' (no agents) press n' });
  const now = Date.now();
  let i = 0;
  for (const p of tree) {
    lines.push({ plain: `▸ ${p.name}` });
    for (const s of p.sessions) {
      const sel = i === cursor;
      const m = getMeta(s.sessionId);
      // suffix after the name (orthogonal):
      //   spinner = claude is processing · * = unread output · × = exited
      let suffix = '';
      if (s.state === 'exited') {
        suffix = ' ×';
      } else {
        if (m.had && now - m.last < ACTIVE_MS) suffix += ` ${spinFrame()}`;
        if (m.unread) suffix += ' *';
      }
      const sn = s.sessionName && s.sessionName !== s.humanName ? ` · ${s.sessionName}` : '';
      lines.push({
        plain: `  ${sel ? '❯' : ' '} ${s.humanName} [${s.role}]${sn}${suffix}`,
        idx: i,
      });
      i++;
    }
  }
  return lines;
}

function anyActive(): boolean {
  const now = Date.now();
  for (const s of flat) {
    const m = meta.get(s.sessionId);
    if (s.state !== 'exited' && m?.had && now - m.last < ACTIVE_MS) return true;
  }
  return false;
}

// plain text only (cells are width-padded; ANSI would break alignment)
function sidebarLines(cwd: string | undefined): string[] {
  const out: string[] = ['▸ workspace'];
  const info = cwd ? wsCache.get(cwd) : undefined;
  if (!cwd) return [...out, '(no agent)'];
  if (!info) return [...out, '(loading…)'];
  if (info.git) {
    const g = info.git;
    out.push(`git ${g.branch}${g.ahead ? ` ^${g.ahead}` : ''}${g.behind ? ` v${g.behind}` : ''}`);
    if (g.files.length === 0) out.push(' clean');
    for (const f of g.files.slice(0, Math.max(3, Math.floor(H / 3)))) {
      out.push(` ${f.xy} ${f.path}`);
    }
  } else {
    out.push('git: not a repo');
  }
  out.push('', 'files');
  for (const e of info.tree) {
    const name = e.path.split('/').pop() ?? e.path;
    out.push(`${'  '.repeat(e.depth)}${e.dir ? '>' : ' '} ${name}${e.dir ? '/' : ''}`);
  }
  return out;
}

function toggleSidebar(): void {
  sidebar = !sidebar;
  computeLayout();
  for (const [id, t] of terms) {
    t.resize(RW, H);
    void rpc.request('session.resize', { sessionId: id, cols: RW, rows: H });
  }
  if (sidebar) void fetchWs(true);
  out(`${ESC}[2J`);
  dirty = true;
}

async function fetchWs(force = false): Promise<void> {
  if (!sidebar) return;
  const s = flat.find((x) => x.sessionId === focusedId);
  if (!s) return;
  if (!force && Date.now() - wsFetchAt < 4000) return;
  wsFetchAt = Date.now();
  try {
    const r = await rpc.request<{ info: WorkspaceInfoDTO }>('workspace.info', { dir: s.cwd });
    wsCache.set(s.cwd, r.info);
    dirty = true;
  } catch {
    /* ignore */
  }
}

/** Fullscreen the focused session's claude (no tree/sep/sidebar) so native
 *  drag-select/copy grabs ONLY claude text. Mouse is released here. */
function renderZoom(): void {
  const ft = focusedId ? terms.get(focusedId) : undefined;
  const fb = ft?.buffer.active;
  const s = flat.find((x) => x.sessionId === focusedId);
  const h = ROWS - 1;
  const off = focusedId ? (scrollOff.get(focusedId) ?? 0) : 0;
  let frame = HIDE;
  for (let i = 0; i < h; i++) {
    const line = fb ? lineToAnsi(fb.getLine(Math.max(0, fb.baseY - off) + i), COLS) : '';
    frame += at(i + 1, 1) + line + `${ESC}[K`;
  }
  frame +=
    at(ROWS, 1) +
    `${ESC}[2K${DIM} fullscreen ${s ? `${s.humanName}/${s.sessionName} ` : ''}· drag = select/copy · ${RESET}${BOLD}Ctrl-Z${RESET}${DIM}/${BOLD}Ctrl-]${RESET}${DIM} exit${RESET}`;
  out(frame);
}

function renderSplit(): void {
  const tl = treeLines();
  let top = 0;
  const curRow = tl.findIndex((l) => l.idx === cursor);
  if (curRow >= H) top = curRow - H + 1;

  const ft = focusedId ? terms.get(focusedId) : undefined;
  const fb = ft?.buffer.active;
  const fSession = flat.find((s) => s.sessionId === focusedId);

  let frame = HIDE;
  const title = `${BOLD}${CYAN} Ateam ${RESET}${DIM}·${RESET} `;
  const who = fSession
    ? `${BOLD}${fSession.humanName}${RESET}${DIM} [${fSession.role}] ${fSession.cwd}${RESET}${expertiseSummary(fSession.humanId)}`
    : `${DIM}no agent selected${RESET}`;
  frame += at(1, 1) + `${ESC}[2K` + title + who;

  const sb = sidebar ? sidebarLines(fSession?.cwd) : [];
  const sideSepCol = LW + RW + 2; // 1-based col of the sidebar separator
  rowMap = [];
  for (let i = 0; i < H; i++) {
    const r = BODY_TOP + i;
    const ln = tl[top + i];
    let left = padCols(ln ? ln.plain : '', LW); // width-aware: CJK names stay aligned
    if (ln && ln.idx === cursor && focus === 'tree') left = `${REV}${left}${RESET}`;
    if (ln?.idx !== undefined) rowMap[i] = ln.idx;

    // read the live viewport (baseY..baseY+rows-1), NOT the top of scrollback.
    // xterm already clipped each line to RW cells, so print it as-is (its CJK
    // chars are already laid out by claude) and clear the rest of the row.
    let right: string;
    if (fb) {
      const off = focusedId ? (scrollOff.get(focusedId) ?? 0) : 0;
      right = lineToAnsi(fb.getLine(Math.max(0, fb.baseY - off) + i), RW);
    } else if (i === 1) right = '  select an agent (Enter / click), or press n';
    else right = '';

    if (sidebar) {
      frame +=
        at(r, 1) +
        left +
        `${DIM}│${RESET}` +
        at(r, LW + 2) +
        `${ESC}[K` +
        right +
        at(r, sideSepCol) +
        `${DIM}│${RESET}` +
        padCols(sb[i] ?? '', SW);
    } else {
      frame += at(r, 1) + left + `${DIM}│${RESET}` + right + `${ESC}[K`;
    }
  }
  const foot = statusMsg
    ? ` ${BOLD}${statusMsg}${RESET}`
    : focus === 'term'
      ? ` ${BOLD}Ctrl-]${RESET}${DIM} tree · type to talk · wheel scrolls · ${RESET}${BOLD}Ctrl-Z${RESET}${DIM} fullscreen-copy${RESET}${
          focusedId && (scrollOff.get(focusedId) ?? 0) > 0
            ? ` ${BOLD}↑scrolled ${scrollOff.get(focusedId)} (type to return)${RESET}`
            : ''
        }`
      : ` ${DIM}j/k · ${RESET}${BOLD}Enter${RESET}${DIM} talk · ${RESET}${BOLD}R${RESET}${DIM} reflect · ${RESET}${BOLD}g${RESET}${DIM} growth · ${RESET}${BOLD}n${RESET}${DIM} new · ${RESET}${BOLD}p${RESET}${DIM} project · ${RESET}${BOLD}S${RESET}${DIM} setup · ${RESET}${BOLD}b${RESET}${DIM} sidebar · ${RESET}${BOLD}Ctrl-Z${RESET}${DIM} fullscreen · ${RESET}${BOLD}x${RESET}${DIM} kill · ${RESET}${BOLD}q${RESET}${DIM} quit${RESET}`;
  const metaSeg = metaStatus ? `  ${CYAN}${metaStatus.slice(0, 50)}${RESET}` : '';
  frame += at(ROWS, 1) + `${ESC}[2K` + foot + metaSeg;

  if (focus === 'term' && fb) {
    frame += at(BODY_TOP + fb.cursorY, LW + 2 + fb.cursorX) + SHOW;
  }
  out(frame);
}

// --- new-session form ---
interface Field {
  label: string;
  def: () => string;
  key: 'agentName' | 'role' | 'dir' | 'projectName';
  /** 'select' renders a pick-list; otherwise a text input */
  type?: 'text' | 'select';
  options?: string[];
}
const CUSTOM_ROLE = 'custom…';
const CUSTOM_DIR = '✎ type a path…';
const NO_DIR = '◇ no directory · talk to this human (agent navigates)';
let recentDirs: { dir: string; source: string }[] = [];

/** Default project name = the workspace's actual project (git repo / folder). */
function deriveProjectName(dir: string): string {
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (top) return basename(top);
  } catch {
    /* not a git repo */
  }
  try {
    const b = basename(dir);
    if (b) return b;
  } catch {
    /* ignore */
  }
  return 'project';
}

const BASE_FIELDS: Field[] = [
  { label: 'human name', def: () => 'coder-1', key: 'agentName' },
  {
    label: 'role',
    def: () => 'coder',
    key: 'role',
    type: 'select',
    options: ['coder', 'reviewer', 'tester', 'tech-lead', CUSTOM_ROLE],
  },
  { label: 'workspace dir', def: () => process.cwd(), key: 'dir' },
];
const PROJECT_FIELD: Field = {
  label: 'project',
  def: () => deriveProjectName(formVals.dir || process.cwd()),
  key: 'projectName',
};
const NAME_FIELD = BASE_FIELDS[0] as Field;
const ROLE_FIELD = BASE_FIELDS[1] as Field;
/** workspace dir = a picker: a directory-less "talk to the human" option
 *  first, then recent projects (Claude/Codex/Cursor/Ateam), then free text. */
function dirField(): Field {
  return {
    label: 'workspace dir',
    key: 'dir',
    def: () => NO_DIR,
    type: 'select',
    options: [NO_DIR, ...recentDirs.map((d) => d.dir), CUSTOM_DIR],
  };
}
let activeFields: Field[] = [];
/** when set, the agent joins this existing project (project field skipped) */
let lockedProject: { name: string; id?: string } | null = null;

// new = new SESSION: pick an existing human (+project) OR create a new human
let humanList: HumanDTO[] = [];
let humanSel = 0;
let chosenHuman: { id?: string; name: string; role: string } | null = null;
let newHumanId: string | null = null; // id of a just-created human (skills step)

type FormStage = 'human' | 'fields' | 'newskills' | 'choose';
let formStage: FormStage = 'fields';
let fIdx = 0;
let buf = '';
let formVals: Record<string, string> = {};
let formError = '';
let chooseList: ClaudeSessionInfo[] = []; // index 0 is implicit "new"
let chooseIdx = 0;
let selIdx = 0; // cursor within a 'select' field's options
let customEntry = false; // user picked custom… -> free-text the role
let directoryless = false; // user picked "no directory" -> talk to the human

function renderPrompt(): void {
  let s = `${ESC}[2J${at(1, 1)}${SHOW}`;
  const where = lockedProject ? ` ${DIM}→ project: ${lockedProject.name}${RESET}` : '';
  s += `${BOLD}New session${RESET}${where} ${DIM}(j/k, Enter · Ctrl-C cancel)${RESET}\r\n`;
  s += `${DIM}─────────────────────────────────────────────${RESET}\r\n`;
  if (formStage === 'human') {
    s += `  ${DIM}pick a human for this session, or create one${RESET}\r\n\r\n`;
    const rows = [
      ...humanList.map((h) => `${h.name} ${DIM}[${h.role}] · ${h.projects.length} proj${RESET}`),
      `${BOLD}✚ new human${RESET}`,
    ];
    if (humanList.length === 0) s += `  ${DIM}(no humans yet)${RESET}\r\n`;
    rows.forEach((r, i) => {
      s += `  ${i === humanSel ? `${REV}❯ ${r} ${RESET}` : `  ${r}`}\r\n`;
    });
    if (formError) s += `\r\n${RED} ${formError}${RESET}\r\n`;
    out(s);
    return;
  }
  if (formStage === 'newskills') {
    s += `  ${DIM}assign skills to ${formVals.agentName || 'coder-1'} [${formVals.role || 'coder'}] · space 勾选 · a 全选 · Enter 分配并继续 · s 跳过${RESET}\r\n\r\n`;
    if (srcList.length === 0) s += `  ${DIM}(未发现可分配的技能源)${RESET}\r\n`;
    srcList.forEach((u, i) => {
      const box = srcChecked.has(i) ? '[x]' : '[ ]';
      const cur = i === srcSel ? `${REV}❯${RESET}` : ' ';
      const asg =
        u.assignedTo.length > 0
          ? ` ${GREEN}✓ ${u.assignedTo.map((a) => a.humanName).join(',')}${RESET}`
          : '';
      s += `  ${cur} ${box} ${u.label} ${DIM}(${u.docCount} ${u.kind}) ${u.origin}${RESET}${asg}\r\n`;
    });
    if (formError) s += `\r\n${DIM} ${formError}${RESET}\r\n`;
    out(s);
    return;
  }
  if (chosenHuman) {
    s += `  ${DIM}human:${RESET} ${chosenHuman.name} ${DIM}[${chosenHuman.role}]${RESET}\r\n\r\n`;
  }
  for (let i = 0; i < activeFields.length; i++) {
    const f = activeFields[i];
    if (!f) continue;
    if (i < fIdx || formStage === 'choose') {
      s += `  ${DIM}${f.label}:${RESET} ${formVals[f.key]}\r\n`;
    } else if (i === fIdx) {
      if (f.type === 'select' && !customEntry) {
        s += `  ${BOLD}${f.label}${RESET} ${DIM}(j/k or 1-9, Enter):${RESET}\r\n`;
        (f.options ?? []).forEach((o, oi) => {
          s += `    ${oi === selIdx ? `${REV}❯ ${o} ${RESET}` : `  ${o}`}\r\n`;
        });
      } else {
        const hint = customEntry ? '(type a value)' : `[${f.def()}]`;
        s += `  ${BOLD}${f.label}${RESET} ${DIM}${hint}${RESET}: ${buf}${REV} ${RESET}\r\n`;
      }
    } else {
      s += `  ${DIM}${f.label}: …${RESET}\r\n`;
    }
  }
  if (formStage === 'choose') {
    s += `\r\n${BOLD} Claude session${RESET} ${DIM}(j/k, Enter; this dir)${RESET}\r\n`;
    const opts = [
      { label: '✚  New session', sub: '' },
      ...chooseList.map((c) => {
        const title = c.title?.trim();
        const summary = c.summary && c.summary !== '(no summary)' ? c.summary : '';
        const label = title || summary || '(untitled session)';
        const excerpt = title && summary && summary !== title ? ` ${DIM}— ${summary}${RESET}` : '';
        const when = c.mtime
          ? `  ${DIM}${c.mtime.slice(0, 16).replace('T', ' ')} · ${c.id.slice(0, 8)}${RESET}`
          : '';
        return { label, sub: `${excerpt}${when}` };
      }),
    ];
    opts.forEach((o, i) => {
      const sel = i === chooseIdx;
      s += `  ${sel ? `${REV}❯ ${o.label} ${RESET}` : `  ${o.label}`}${o.sub}\r\n`;
    });
  }
  if (formError) s += `\r\n${RED} ${formError}${RESET}\r\n`;
  out(s);
}

function startForm(lock: { name: string; id?: string } | null): void {
  mode = 'prompt';
  lockedProject = lock;
  formStage = 'human';
  fIdx = 0;
  buf = '';
  formVals = {};
  formError = '';
  chooseList = [];
  chooseIdx = 0;
  selIdx = 0;
  customEntry = false;
  directoryless = false;
  chosenHuman = null;
  newHumanId = null;
  humanList = [];
  humanSel = 0;
  recentDirs = [];
  renderPrompt();
  void rpc
    .request<{ humans: HumanDTO[] }>('human.list')
    .then((r) => {
      humanList = r.humans;
      if (formStage === 'human') renderPrompt();
    })
    .catch(() => {});
  void rpc
    .request<{ dirs: { dir: string; source: string }[] }>('project.recent')
    .then((r) => {
      recentDirs = r.dirs;
    })
    .catch(() => {});
}

/** pick existing human -> just (dir[, project]); new human -> name+role+(dir[,project]) */
function pickHuman(): void {
  if (humanSel >= humanList.length) {
    chosenHuman = null;
    activeFields = [NAME_FIELD, ROLE_FIELD, dirField(), ...(lockedProject ? [] : [PROJECT_FIELD])];
  } else {
    const h = humanList[humanSel];
    if (!h) return;
    chosenHuman = { id: h.id, name: h.name, role: h.role };
    activeFields = [dirField(), ...(lockedProject ? [] : [PROJECT_FIELD])];
  }
  formStage = 'fields';
  fIdx = 0;
  buf = '';
  selIdx = 0;
  renderPrompt();
}

// --- right-click context menu: add an agent to a project / new project ---
interface MenuItem {
  label: string;
  isNew: boolean;
  projectName?: string;
  projectId?: string;
}
let menuItems: MenuItem[] = [];
let menuIdx = 0;
const MENU_TOP = 3;

function openMenu(): void {
  menuItems = [
    { label: '✚  New project', isNew: true },
    ...tree.map((p) => ({
      label: `＋  ${p.name} ${DIM}(${p.sessions.length})${RESET}`,
      isNew: false,
      projectName: p.name,
      projectId: p.projectId,
    })),
  ];
  menuIdx = 0;
  mode = 'menu';
  renderMenu();
}

function renderMenu(): void {
  let s = `${ESC}[2J${at(1, 1)}${SHOW}`;
  s += `${BOLD}Add agent to…${RESET} ${DIM}(j/k, Enter · Ctrl-C cancel)${RESET}\r\n`;
  s += `${DIM}─────────────────────────────────────────────${RESET}\r\n`;
  menuItems.forEach((it, i) => {
    const sel = i === menuIdx;
    s += `  ${sel ? `${REV}❯ ${it.label} ${RESET}` : `  ${it.label}`}\r\n`;
  });
  out(s);
}

function chooseMenu(i: number): void {
  const it = menuItems[i];
  if (!it) return;
  if (it.isNew) startForm(null);
  else startForm({ name: it.projectName as string, id: it.projectId });
}

function onMenuKey(data: string): void {
  if (data === '\x03' || data === 'q' || data === ESC) {
    mode = 'split';
    out(`${ESC}[2J`);
    dirty = true;
    return;
  }
  const mouse = parseMouse(data);
  if (mouse) {
    if (mouse.btn === 0 && mouse.press) {
      const i = mouse.y - MENU_TOP;
      if (i >= 0 && i < menuItems.length) chooseMenu(i);
    }
    return;
  }
  if (data === 'j' || data === `${ESC}[B`) {
    menuIdx = Math.min(menuItems.length - 1, menuIdx + 1);
    renderMenu();
  } else if (data === 'k' || data === `${ESC}[A`) {
    menuIdx = Math.max(0, menuIdx - 1);
    renderMenu();
  } else if (data === '\r' || data === '\n') {
    chooseMenu(menuIdx);
  } else if (/^[0-9]$/.test(data)) {
    const n = Number(data);
    if (n < menuItems.length) chooseMenu(n);
  }
}

async function enterChooseStage(): Promise<void> {
  // directory-less has no cwd to enumerate prior claude sessions for
  if (directoryless) {
    void submitForm(undefined);
    return;
  }
  const dir = formVals.dir as string;
  try {
    const res = await rpc.request<{ sessions: ClaudeSessionInfo[] }>('claude.sessions', {
      cwd: dir,
    });
    chooseList = res.sessions;
  } catch {
    chooseList = [];
  }
  if (chooseList.length === 0) {
    void submitForm(undefined);
    return;
  }
  formStage = 'choose';
  chooseIdx = 0;
  renderPrompt();
}

async function submitForm(resumeSessionId: string | undefined): Promise<void> {
  const agentName = chosenHuman?.name ?? (formVals.agentName || 'coder-1');
  const role = chosenHuman?.role ?? (formVals.role || 'coder');
  const dir = formVals.dir || process.cwd();
  // directory-less sessions group under the human's own name in the tree
  const projectName = directoryless
    ? agentName
    : (lockedProject?.name ?? (formVals.projectName || deriveProjectName(dir)));
  out(`\r\n${DIM} starting…${RESET}`);
  try {
    const known = directoryless
      ? projectIds.get(projectName)
      : (lockedProject?.id ?? projectIds.get(projectName));
    const res = await rpc.request<{ session: SessionNode }>('session.spawn', {
      projectId: known,
      projectName,
      agentName,
      role,
      // existing human -> reuse by id; new -> created/deduped by name+role.
      // One human can have many concurrent sessions.
      human:
        chosenHuman?.id || newHumanId
          ? { id: (chosenHuman?.id ?? newHumanId) as string, name: agentName, role }
          : { name: agentName, role },
      ...(directoryless
        ? { directoryless: true }
        : { workspace: { id: `ws-${dir}`, name: projectName, root: dir } }),
      resumeSessionId,
      cols: RW,
      rows: H,
    });
    projectIds.set(projectName, res.session.projectId);
    mode = 'split';
    focusedId = res.session.sessionId;
    focus = 'term';
    termFor(res.session.sessionId);
    markRead(res.session.sessionId);
    await refresh();
    out(`${ESC}[2J`);
    renderSplit();
  } catch (e) {
    mode = 'prompt';
    formStage = 'fields';
    const di = activeFields.findIndex((f) => f.key === 'dir');
    fIdx = di >= 0 ? di : 0;
    buf = dir;
    formError = `spawn failed: ${(e as Error).message}`;
    renderPrompt();
  }
}

function advanceField(): void {
  formError = '';
  const just = activeFields[fIdx];
  if (just?.key === 'dir' && formVals.dir === NO_DIR) {
    directoryless = true;
    formVals.dir = ''; // server derives the human's desk dir
  }
  fIdx++;
  buf = '';
  selIdx = 0;
  customEntry = false;
  // directory-less: no project to pick (the agent navigates itself)
  while (directoryless && activeFields[fIdx]?.key === 'projectName') fIdx++;
  if (fIdx >= activeFields.length) {
    // a brand-new human gets a skill-assignment step before spawning
    if (!chosenHuman && !newHumanId) {
      void startNewHumanSkills();
      return;
    }
    void enterChooseStage();
    return;
  }
  renderPrompt();
}

async function startNewHumanSkills(): Promise<void> {
  const name = formVals.agentName || 'coder-1';
  const role = formVals.role || 'coder';
  formStage = 'newskills';
  formError = 'creating human & scanning skills…';
  renderPrompt();
  try {
    const h = await rpc.request<{ human: { id: string } }>('human.create', { name, role });
    newHumanId = h.human.id;
  } catch {
    newHumanId = '';
  }
  try {
    const u = await rpc.request<{ units: SkillUnitDTO[] }>('skill.units', {
      projectDir: process.cwd(),
    });
    srcList = u.units;
  } catch {
    srcList = [];
  }
  srcChecked = new Set(
    srcList.map((x, i) => (x.assignedTo.length === 0 ? i : -1)).filter((i) => i >= 0),
  );
  srcSel = 0;
  formError = '';
  renderPrompt();
}

async function finishNewHumanSkills(doImport: boolean): Promise<void> {
  if (doImport && newHumanId) {
    formError = 'assigning skills…';
    renderPrompt();
    for (const u of srcList.filter((_, i) => srcChecked.has(i))) {
      try {
        await rpc.request('skill.importUnit', {
          humanId: newHumanId,
          unitPath: u.path,
          kind: u.kind,
          entry: u.entry,
          scope: 'global',
        });
      } catch {
        /* skip a bad unit */
      }
    }
  }
  formError = '';
  void enterChooseStage();
}

function onPromptKey(data: string): void {
  if (data === '\x03') {
    mode = 'split';
    out(`${ESC}[2J`);
    renderSplit();
    return;
  }

  if (formStage === 'human') {
    const len = humanList.length + 1; // + "new human"
    if (data === 'j' || data === `${ESC}[B`) {
      humanSel = Math.min(len - 1, humanSel + 1);
      renderPrompt();
    } else if (data === 'k' || data === `${ESC}[A`) {
      humanSel = Math.max(0, humanSel - 1);
      renderPrompt();
    } else if (/^[1-9]$/.test(data)) {
      const n = Number(data) - 1;
      if (n < len) {
        humanSel = n;
        renderPrompt();
      }
    } else if (data === '\r' || data === '\n') {
      pickHuman();
    }
    return;
  }

  if (formStage === 'newskills') {
    if (data === 'j' || data === `${ESC}[B`) srcSel = Math.min(srcList.length - 1, srcSel + 1);
    else if (data === 'k' || data === `${ESC}[A`) srcSel = Math.max(0, srcSel - 1);
    else if (data === ' ') {
      if (srcChecked.has(srcSel)) srcChecked.delete(srcSel);
      else srcChecked.add(srcSel);
    } else if (data === 'a') {
      if (srcChecked.size === srcList.length) srcChecked.clear();
      else srcChecked = new Set(srcList.map((_, i) => i));
    } else if (data === 's') {
      void finishNewHumanSkills(false);
      return;
    } else if (data === '\r' || data === '\n') {
      void finishNewHumanSkills(true);
      return;
    } else return;
    renderPrompt();
    return;
  }

  if (formStage === 'choose') {
    const len = chooseList.length + 1;
    if (data === 'j' || data === `${ESC}[B`) {
      chooseIdx = Math.min(len - 1, chooseIdx + 1);
      renderPrompt();
    } else if (data === 'k' || data === `${ESC}[A`) {
      chooseIdx = Math.max(0, chooseIdx - 1);
      renderPrompt();
    } else if (data === '\r' || data === '\n') {
      const resume = chooseIdx === 0 ? undefined : chooseList[chooseIdx - 1]?.id;
      void submitForm(resume);
    } else if (/^[0-9]$/.test(data)) {
      const n = Number(data);
      if (n < len) {
        chooseIdx = n;
        renderPrompt();
      }
    }
    return;
  }

  // 'select' field (e.g. role): pick-list, not text entry
  const cf = activeFields[fIdx];
  if (cf && cf.type === 'select' && !customEntry) {
    const opts = cf.options ?? [];
    if (data === 'j' || data === `${ESC}[B`) selIdx = Math.min(opts.length - 1, selIdx + 1);
    else if (data === 'k' || data === `${ESC}[A`) selIdx = Math.max(0, selIdx - 1);
    else if (/^[1-9]$/.test(data)) {
      const n = Number(data) - 1;
      if (n < opts.length) selIdx = n;
    } else if (data === '\r' || data === '\n') {
      const choice = opts[selIdx] ?? cf.def();
      if (choice === CUSTOM_ROLE || choice === CUSTOM_DIR) {
        customEntry = true;
        buf = '';
        renderPrompt();
        return;
      }
      formVals[cf.key] = choice;
      advanceField();
      return;
    } else {
      return;
    }
    renderPrompt();
    return;
  }

  if (data.startsWith(ESC)) return;
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      const f = activeFields[fIdx];
      if (!f) continue;
      formVals[f.key] = buf.trim() || f.def();
      if (f.key === 'dir') {
        const d = formVals.dir as string;
        if (!existsSync(d) || !statSync(d).isDirectory()) {
          formError = `not a directory: ${d}`;
          buf = '';
          renderPrompt();
          return;
        }
      }
      advanceField();
      return;
    } else if (ch === '\x7f' || ch === '\b') {
      buf = buf.slice(0, -1);
      renderPrompt();
    } else if (ch >= ' ') {
      buf += ch;
      renderPrompt();
    }
  }
}

interface MouseEvent {
  btn: number;
  x: number;
  y: number;
  press: boolean;
}
function parseMouse(d: string): MouseEvent | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal mouse escape
  const m = d.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!m) return null;
  return { btn: Number(m[1]), x: Number(m[2]), y: Number(m[3]), press: m[4] === 'M' };
}

function selectFlat(idx: number): void {
  cursor = idx;
  const s = flat[idx];
  if (s) {
    focusedId = s.sessionId;
    markRead(s.sessionId);
  }
  dirty = true;
}

async function onKey(data: string): Promise<void> {
  if (mode === 'prompt') return onPromptKey(data);
  if (mode === 'menu') return onMenuKey(data);
  if (mode === 'resume') return onResumeKey(data);
  if (mode === 'growth') return onGrowthKey(data);
  if (mode === 'setup') return onSetupKey(data);
  if (mode === 'zoom') {
    // Ctrl-Z or Ctrl-] exits fullscreen; everything else goes to claude
    if (data.includes('\x1a') || data.includes('\x1d')) {
      mode = 'split';
      out(`${ESC}[2J`);
      dirty = true;
      return;
    }
    if (focusedId) await rpc.request('session.input', { sessionId: focusedId, data });
    return;
  }
  // Ctrl-Z toggles fullscreen-copy of the focused session (tree or term)
  if (data.includes('\x1a') && focusedId) {
    mode = 'zoom';
    out(`${ESC}[2J`);
    dirty = true;
    return;
  }
  if (statusMsg) {
    statusMsg = '';
    dirty = true;
  }

  const mouse = parseMouse(data);
  if (mouse) {
    if (mouse.btn === 2 && mouse.press) {
      openMenu(); // right-click: add agent to a project / new project
      return;
    }
    if (mouse.x <= LW) {
      if (mouse.btn === 64) {
        cursor = Math.max(0, cursor - 1);
        dirty = true;
      } else if (mouse.btn === 65) {
        cursor = Math.min(flat.length - 1, cursor + 1);
        dirty = true;
      } else if (mouse.btn === 0 && mouse.press) {
        focus = 'tree';
        const i = mouse.y - BODY_TOP;
        const idx = i >= 0 ? rowMap[i] : undefined;
        if (idx !== undefined) {
          if (idx === cursor && focusedId) {
            focus = 'term';
            markRead(focusedId);
          } else selectFlat(idx);
        }
        dirty = true;
      }
    } else if (focusedId) {
      // right pane: wheel scrolls the claude session scrollback
      const ft = terms.get(focusedId);
      const maxOff = ft ? ft.buffer.active.baseY : 0;
      const cur = scrollOff.get(focusedId) ?? 0;
      if (mouse.btn === 64) {
        scrollOff.set(focusedId, Math.min(maxOff, cur + 3));
        dirty = true;
      } else if (mouse.btn === 65) {
        scrollOff.set(focusedId, Math.max(0, cur - 3));
        dirty = true;
      } else if (mouse.btn === 0 && mouse.press) {
        focus = 'term';
        markRead(focusedId);
        dirty = true;
      }
    }
    return;
  }

  if (focus === 'term' && focusedId) {
    if (data.includes('\x1d')) {
      focus = 'tree';
      scrollOff.set(focusedId, 0); // back to live on detach
      dirty = true;
      return;
    }
    markRead(focusedId);
    scrollOff.set(focusedId, 0); // typing snaps the view back to live bottom
    await rpc.request('session.input', { sessionId: focusedId, data });
    return;
  }

  if (data === '\x03' || data === 'q') return shutdown(0);
  if (data === 'n') return startForm(null);
  if (data === 'p') return openMenu();
  if (data === 'R') return void reflectFocused();
  if (data === 'g') return openGrowth();
  if (data === 'S') return startWizard();
  if (data === 'b') return toggleSidebar();
  if (data === 'r') return void refresh();
  if (data === '\t') {
    if (focusedId) {
      focus = 'term';
      markRead(focusedId);
    }
    dirty = true;
    return;
  }
  if (data === 'j' || data === `${ESC}[B`) {
    cursor = Math.min(flat.length - 1, cursor + 1);
    selectFlat(cursor);
    return;
  }
  if (data === 'k' || data === `${ESC}[A`) {
    cursor = Math.max(0, cursor - 1);
    selectFlat(cursor);
    return;
  }
  if (data === 'x') {
    const s = flat[cursor];
    if (s) {
      await rpc.request('session.kill', { sessionId: s.sessionId });
      terms.delete(s.sessionId);
      meta.delete(s.sessionId);
      setTimeout(() => void refresh(), 150);
    }
    return;
  }
  if (data === '\r' || data === '\n' || data === 'a') {
    const s = flat[cursor];
    if (s) {
      focusedId = s.sessionId;
      focus = 'term';
      termFor(s.sessionId);
      markRead(s.sessionId);
      dirty = true;
    }
  }
}

function onResize(): void {
  computeLayout();
  for (const [id, t] of terms) {
    t.resize(RW, H);
    void rpc.request('session.resize', { sessionId: id, cols: RW, rows: H });
  }
  out(`${ESC}[2J`);
  dirty = true;
}

function shutdown(code: number): void {
  saveState();
  try {
    server.shutdown();
  } catch {
    /* ignore */
  }
  out(MOUSE_OFF + SHOW + ALT_OFF);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  out(RESET + '\r\n');
  process.exit(code);
}

// --- first-run setup wizard (per-role skills / learn-from-project) ---
const SETUP_ROLES = ['coder', 'reviewer', 'tester', 'tech-lead'];
type SetupStage = 'role' | 'name' | 'action' | 'path' | 'sources';
let setupStage: SetupStage = 'role';
let setupRole = '';
let setupHumanId = '';
let setupNameBuf = '';
let setupSel = 0;
let setupPath = '';
let setupActionMode: 'import' | 'learn' = 'import';
let setupBusy = '';
let setupNote = '';
let srcList: SkillUnitDTO[] = [];
let srcSel = 0;
let srcChecked = new Set<number>();

function startWizard(): void {
  mode = 'setup';
  setupStage = 'role';
  setupSel = 0;
  setupBusy = '';
  setupNote = '';
  renderSetup();
}

function setupList(): string[] {
  if (setupStage === 'role') return [...SETUP_ROLES, '✓ done & continue'];
  if (setupStage === 'action')
    return [
      'scan known locations (cwd + global claude/cursor/codex)',
      'import a folder or file path',
      'learn from a project (claude scans it)',
      'skip this role',
      '← back',
    ];
  return [];
}

function renderSetup(): void {
  let s = `${ESC}[2J${at(1, 1)}${SHOW}`;
  s += `${BOLD}首次设置 / Setup${RESET} ${DIM}— 为每个角色配置 Skill / 学习工程；Esc 跳过全部${RESET}\r\n`;
  s += `${DIM}─────────────────────────────────────────────${RESET}\r\n`;
  if (setupStage === 'name') {
    s += `  ${DIM}role:${RESET} ${setupRole}\r\n\r\n`;
    s += `  ${BOLD}human name${RESET} ${DIM}[${setupRole}-1] (Enter 确认 · Ctrl-C 返回)${RESET}: ${setupNameBuf}${REV} ${RESET}\r\n`;
  } else if (setupStage === 'path') {
    s += `  ${DIM}human:${RESET} ${setupNameBuf} [${setupRole}]  ${DIM}·${RESET} ${setupActionMode === 'import' ? 'Skill 文档目录/文件' : '学习的工程目录'}\r\n\r\n`;
    s += `  ${BOLD}path${RESET} ${DIM}(Enter 确认 · Ctrl-C 返回)${RESET}: ${setupPath}${REV} ${RESET}\r\n`;
  } else if (setupStage === 'sources') {
    s += `  ${DIM}human: ${setupNameBuf} [${setupRole}] · space 勾选 · a 全选/全不选 · Enter 导入 · Ctrl-C 返回${RESET}\r\n\r\n`;
    if (srcList.length === 0) s += `  ${DIM}(未发现已知技能/规则位置)${RESET}\r\n`;
    srcList.forEach((u, i) => {
      const box = srcChecked.has(i) ? '[x]' : '[ ]';
      const cur = i === srcSel ? `${REV}❯${RESET}` : ' ';
      const assigned =
        u.assignedTo.length > 0
          ? ` ${GREEN}✓ assigned: ${u.assignedTo.map((a) => a.humanName).join(', ')}${RESET}`
          : '';
      s += `  ${cur} ${box} ${u.label} ${DIM}(${u.docCount} ${u.kind}) ${u.origin}${RESET}${assigned}\r\n      ${DIM}${u.path}${RESET}\r\n`;
    });
  } else {
    if (setupStage === 'action')
      s += `  ${DIM}human: ${setupNameBuf} [${setupRole}]${RESET}\r\n\r\n`;
    setupList().forEach((o, i) => {
      s += `  ${i === setupSel ? `${REV}❯ ${o} ${RESET}` : `  ${o}`}\r\n`;
    });
  }
  if (setupBusy) s += `\r\n${BOLD} ${setupBusy}${RESET}\r\n`;
  if (setupNote) s += `\r\n${GREEN} ${setupNote}${RESET}\r\n`;
  out(s);
}

async function finishWizard(): Promise<void> {
  try {
    await rpc.request('config.finish');
  } catch {
    /* ignore */
  }
  await proceedStartup();
}

async function submitSetupPath(): Promise<void> {
  const dir = setupPath.trim();
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    setupNote = '';
    setupBusy = `not a directory: ${dir}`;
    renderSetup();
    return;
  }
  setupBusy =
    setupActionMode === 'import'
      ? 'importing skill docs…'
      : 'learning from project (claude, may take a while)…';
  setupNote = '';
  renderSetup();
  try {
    if (setupActionMode === 'import') {
      const r = await rpc.request<{ imported: number }>('skill.import', {
        agentKey: setupHumanId,
        dir,
        scope: 'global',
      });
      await rpc.request('config.markRole', { role: setupRole, skillDir: dir });
      setupNote = `✓ imported ${r.imported} skill doc(s) for ${setupRole}`;
    } else {
      const r = await rpc.request<{ learned: number }>('skill.learn', {
        agentKey: setupHumanId,
        projectDir: dir,
        scope: 'global',
      });
      await rpc.request('config.markRole', { role: setupRole, learnedProject: dir });
      setupNote = `✓ learned ${r.learned} skill/knowledge item(s) for ${setupRole}`;
    }
  } catch (e) {
    setupNote = `failed: ${(e as Error).message}`;
  }
  setupBusy = '';
  setupStage = 'role';
  setupSel = 0;
  renderSetup();
}

async function openSources(): Promise<void> {
  setupBusy = 'scanning known locations…';
  setupNote = '';
  renderSetup();
  try {
    const r = await rpc.request<{ units: SkillUnitDTO[] }>('skill.units', {
      projectDir: process.cwd(),
    });
    srcList = r.units;
  } catch {
    srcList = [];
  }
  // default-select only units NOT already assigned to some human
  srcChecked = new Set(
    srcList.map((u, i) => (u.assignedTo.length === 0 ? i : -1)).filter((i) => i >= 0),
  );
  srcSel = 0;
  setupBusy = '';
  setupStage = 'sources';
  renderSetup();
}

async function importSelectedSources(): Promise<void> {
  const chosen = srcList.filter((_, i) => srcChecked.has(i));
  if (chosen.length === 0) {
    setupNote = 'nothing selected';
    renderSetup();
    return;
  }
  setupBusy = `importing ${chosen.length} skill unit(s) (preserving structure)…`;
  setupNote = '';
  renderSetup();
  let total = 0;
  for (const u of chosen) {
    try {
      const r = await rpc.request<{ imported: number }>('skill.importUnit', {
        humanId: setupHumanId,
        unitPath: u.path,
        kind: u.kind,
        entry: u.entry,
        scope: 'global',
      });
      total += r.imported;
    } catch {
      /* skip a bad unit */
    }
  }
  try {
    await rpc.request('config.markRole', { role: setupRole });
  } catch {
    /* ignore */
  }
  setupBusy = '';
  setupNote = `✓ assigned ${total} skill unit(s) to ${setupNameBuf} [${setupRole}]`;
  setupStage = 'role';
  setupSel = 0;
  renderSetup();
}

function onSetupKey(data: string): void {
  if (setupStage === 'sources') {
    if (data === '\x03' || data === '\x1b') {
      setupStage = 'action';
      setupSel = 0;
      setupBusy = '';
      renderSetup();
      return;
    }
    if (data === 'j' || data === `${ESC}[B`) srcSel = Math.min(srcList.length - 1, srcSel + 1);
    else if (data === 'k' || data === `${ESC}[A`) srcSel = Math.max(0, srcSel - 1);
    else if (data === ' ') {
      if (srcChecked.has(srcSel)) srcChecked.delete(srcSel);
      else srcChecked.add(srcSel);
    } else if (data === 'a') {
      if (srcChecked.size === srcList.length) srcChecked.clear();
      else srcChecked = new Set(srcList.map((_, i) => i));
    } else if (data === '\r' || data === '\n') {
      void importSelectedSources();
      return;
    } else return;
    renderSetup();
    return;
  }
  if (setupStage === 'path') {
    if (data === '\x03') {
      setupStage = 'action';
      setupSel = 0;
      setupBusy = '';
      renderSetup();
      return;
    }
    if (data.startsWith(ESC)) return;
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        void submitSetupPath();
        return;
      }
      if (ch === '\x7f' || ch === '\b') setupPath = setupPath.slice(0, -1);
      else if (ch >= ' ') setupPath += ch;
    }
    renderSetup();
    return;
  }

  if (setupStage === 'name') {
    if (data === '\x03') {
      setupStage = 'role';
      setupSel = 0;
      renderSetup();
      return;
    }
    if (data.startsWith(ESC)) return;
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const name = setupNameBuf.trim() || `${setupRole}-1`;
        setupNameBuf = name;
        setupBusy = 'creating human…';
        renderSetup();
        void rpc
          .request<{ human: { id: string } }>('human.create', { name, role: setupRole })
          .then((r) => {
            setupHumanId = r.human.id;
            setupBusy = '';
            setupStage = 'action';
            setupSel = 0;
            renderSetup();
          })
          .catch(() => {
            setupBusy = 'human.create failed';
            renderSetup();
          });
        return;
      }
      if (ch === '\x7f' || ch === '\b') setupNameBuf = setupNameBuf.slice(0, -1);
      else if (ch >= ' ') setupNameBuf += ch;
    }
    renderSetup();
    return;
  }

  if (data === '\x03' || data === '\x1b') {
    void finishWizard();
    return;
  }
  const list = setupList();
  if (data === 'j' || data === `${ESC}[B`) setupSel = Math.min(list.length - 1, setupSel + 1);
  else if (data === 'k' || data === `${ESC}[A`) setupSel = Math.max(0, setupSel - 1);
  else if (/^[1-9]$/.test(data)) {
    const n = Number(data) - 1;
    if (n < list.length) setupSel = n;
  } else if (data === '\r' || data === '\n') {
    if (setupStage === 'role') {
      if (setupSel >= SETUP_ROLES.length) {
        void finishWizard();
        return;
      }
      setupRole = SETUP_ROLES[setupSel] ?? 'coder';
      setupNameBuf = '';
      setupStage = 'name';
    } else {
      // action: 0 scan · 1 import path · 2 learn · 3 skip · 4 back
      if (setupSel === 0) {
        void openSources();
        return;
      }
      if (setupSel === 3 || setupSel === 4) {
        setupStage = 'role';
        setupSel = 0;
      } else {
        setupActionMode = setupSel === 1 ? 'import' : 'learn';
        setupStage = 'path';
        setupPath = '';
      }
    }
    renderSetup();
    return;
  } else return;
  renderSetup();
}

/** Post-setup startup: resume prompt if there is saved state, else split. */
async function proceedStartup(): Promise<void> {
  savedAgents = loadSessionState();
  if (savedAgents.length > 0) {
    mode = 'resume';
    renderResume();
  } else {
    mode = 'split';
    out(`${ESC}[2J`);
    await refresh();
    renderSplit();
  }
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    out('Ateam TUI requires an interactive terminal (TTY).\n');
    process.exit(1);
  }
  computeLayout();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  out(ALT_ON + MOUSE_ON + `${ESC}[2J`);
  process.stdin.on('data', (d: string) => void onKey(d));
  process.stdout.on('resize', onResize);
  process.on('SIGINT', () => shutdown(0));
  process.on('exit', () => out(MOUSE_OFF + ALT_OFF));
  setInterval(() => {
    applyMouseMode(); // mouse off in term focus -> native text selection
    if (anyActive()) dirty = true; // keep the spinner animating
    if (metaStatus && Date.now() - metaAt > 6000) {
      metaStatus = '';
      dirty = true;
    }
    if (sidebar && mode === 'split') void fetchWs(); // throttled inside
    if ((mode === 'split' || mode === 'zoom') && Date.now() - lastTreeAt > 5000) {
      lastTreeAt = Date.now(); // re-list -> picks up in-session /name renames
      void refresh();
    }
    if (mode === 'split' && dirty) {
      dirty = false;
      renderSplit();
    } else if (mode === 'zoom' && dirty) {
      dirty = false;
      renderZoom();
    }
  }, 50);
  let firstRun = false;
  try {
    const c = await rpc.request<{ firstRun: boolean }>('config.get');
    firstRun = c.firstRun;
  } catch {
    /* treat as not-first-run on error */
  }
  if (firstRun) startWizard();
  else await proceedStartup();
}

void main();
