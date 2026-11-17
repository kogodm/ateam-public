import { execFileSync } from 'node:child_process';
import {
  constants,
  accessSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ateamHome } from './paths';
import { newestCodexRolloutPath } from './session/providers/codex-sessions';

/**
 * How much of each subscription's usage windows has been used — the bars of
 * Claude's / ChatGPT's / Cursor's own usage pages. Claude and Codex leave the
 * numbers on disk as they answer; Cursor's dashboard API is polled with the
 * editor's access token from the macOS keychain.
 */

export type PlanProviderId = 'claude' | 'codex' | 'cursor';

export interface UsageWindow {
  label: string;
  usedPercent: number;
  /** unix seconds the window resets at */
  resetsAt: number;
}

export interface PlanUsage {
  providerId: PlanProviderId;
  windows: UsageWindow[];
  plan?: string;
  /** ms the numbers were read from the CLI / API */
  updatedAt: number;
}

const FIVE_HOURS = 300;
const WEEK = 10080;
/** skip re-hitting Cursor's API within this window; the UI polls every 20s */
const CURSOR_CACHE_MS = 60_000;
const CURSOR_API = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

function usageDir(): string {
  return join(ateamHome(), 'usage');
}

function claudeUsageFile(): string {
  return join(usageDir(), 'claude.json');
}

function codexUsageFile(): string {
  return join(usageDir(), 'codex.json');
}

function cursorUsageFile(): string {
  return join(usageDir(), 'cursor.json');
}

function windowLabel(minutes: number): string {
  if (minutes === FIVE_HOURS) return 'Current session';
  if (minutes === WEEK) return 'This week';
  return minutes % 60 === 0 ? `${minutes / 60}-hour window` : `${minutes}-minute window`;
}

interface ClaudeWindow {
  used_percentage?: number;
  resets_at?: number;
}

/** keep what claude's status line input said about the subscription */
export function saveClaudeRateLimits(
  limits: { five_hour?: ClaudeWindow; seven_day?: ClaudeWindow } | undefined,
  now = Date.now(),
): void {
  if (!limits) return;
  const windows: UsageWindow[] = [];
  const add = (label: string, w: ClaudeWindow | undefined): void => {
    if (typeof w?.used_percentage === 'number' && typeof w.resets_at === 'number')
      windows.push({ label, usedPercent: w.used_percentage, resetsAt: w.resets_at });
  };
  add('Current session', limits.five_hour);
  add('This week', limits.seven_day);
  if (windows.length === 0) return;
  try {
    mkdirSync(usageDir(), { recursive: true });
    writeFileSync(claudeUsageFile(), JSON.stringify({ windows, updatedAt: now }));
  } catch {
    /* a missing bar is not worth breaking the status line */
  }
}

/** a window that already reset says nothing about the new one */
function live(windows: UsageWindow[], now: number): UsageWindow[] {
  return windows.filter((w) => w.resetsAt * 1000 > now);
}

function readSavedPlan(file: string, providerId: PlanProviderId, now: number): PlanUsage | null {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      windows: UsageWindow[];
      updatedAt: number;
      plan?: string;
    };
    const windows = live(saved.windows ?? [], now);
    if (windows.length === 0) return null;
    return {
      providerId,
      windows,
      plan: saved.plan,
      updatedAt: saved.updatedAt,
    };
  } catch {
    return null;
  }
}

function writeSavedPlan(file: string, usage: PlanUsage): void {
  try {
    mkdirSync(usageDir(), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        windows: usage.windows,
        updatedAt: usage.updatedAt,
        plan: usage.plan,
      }),
    );
  } catch {
    /* cache miss next time is fine */
  }
}

export function readClaudePlanUsage(now = Date.now()): PlanUsage | null {
  return readSavedPlan(claudeUsageFile(), 'claude', now);
}

interface CodexWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

/** the newest rate_limits event in the tail of a codex rollout */
export function readCodexPlanUsage(rolloutPath: string, now = Date.now()): PlanUsage | null {
  if (!rolloutPath) return null;
  let text = '';
  try {
    const size = statSync(rolloutPath).size;
    const len = Math.min(size, 256 * 1024);
    const fd = openSync(rolloutPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (!line.includes('"rate_limits"')) continue;
    try {
      const rec = JSON.parse(line) as {
        timestamp?: string;
        payload?: {
          rate_limits?: { primary?: CodexWindow; secondary?: CodexWindow; plan_type?: string };
        };
      };
      const limits = rec.payload?.rate_limits;
      if (!limits) continue;
      const windows: UsageWindow[] = [];
      for (const w of [limits.primary, limits.secondary]) {
        if (typeof w?.used_percent === 'number' && typeof w.resets_at === 'number')
          windows.push({
            label: windowLabel(w.window_minutes ?? 0),
            usedPercent: w.used_percent,
            resetsAt: w.resets_at,
          });
      }
      const fresh = live(windows, now);
      if (fresh.length === 0) return null;
      const usage: PlanUsage = {
        providerId: 'codex',
        windows: fresh.sort((a, b) => a.resetsAt - b.resetsAt),
        plan: limits.plan_type,
        updatedAt: Date.parse(rec.timestamp ?? '') || now,
      };
      writeSavedPlan(codexUsageFile(), usage);
      return usage;
    } catch {
      /* a half-written last line */
    }
  }
  return null;
}

export function readCachedCodexPlanUsage(now = Date.now()): PlanUsage | null {
  return readSavedPlan(codexUsageFile(), 'codex', now);
}

interface CursorPeriodResponse {
  billingCycleEnd?: string | number;
  planUsage?: {
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    totalPercentUsed?: number;
  };
}

/** turn Cursor's GetCurrentPeriodUsage JSON into the same window shape */
export function cursorPlanFromResponse(
  body: CursorPeriodResponse,
  plan: string | undefined,
  now = Date.now(),
): PlanUsage | null {
  const endMs = Number(body.billingCycleEnd);
  if (!Number.isFinite(endMs) || endMs <= now) return null;
  const resetsAt = Math.floor(endMs / 1000);
  const pu = body.planUsage ?? {};
  const windows: UsageWindow[] = [];
  // Cursor's own settings page labels: "Cursor Models" (auto) / "Other Models" (API)
  if (typeof pu.autoPercentUsed === 'number')
    windows.push({ label: 'Cursor Models', usedPercent: pu.autoPercentUsed, resetsAt });
  if (typeof pu.apiPercentUsed === 'number')
    windows.push({ label: 'Other Models', usedPercent: pu.apiPercentUsed, resetsAt });
  if (windows.length === 0 && typeof pu.totalPercentUsed === 'number')
    windows.push({ label: 'This period', usedPercent: pu.totalPercentUsed, resetsAt });
  if (windows.length === 0) return null;
  return { providerId: 'cursor', windows, plan, updatedAt: now };
}

function cursorAccessToken(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const token = execFileSync(
      'security',
      ['find-generic-password', '-s', 'cursor-access-token', '-a', 'cursor-user', '-w'],
      { encoding: 'utf8', timeout: 3000 },
    ).trim();
    return token || null;
  } catch {
    return null;
  }
}

function sqlite3Bin(): string | null {
  for (const candidate of [
    '/usr/bin/sqlite3',
    '/usr/local/bin/sqlite3',
    '/opt/homebrew/bin/sqlite3',
  ]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

function cursorMembershipType(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const bin = sqlite3Bin();
  if (!bin) return undefined;
  const db = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  try {
    const out = execFileSync(
      bin,
      ['-readonly', db, "SELECT value FROM ItemTable WHERE key='cursorAuth/stripeMembershipType'"],
      { encoding: 'utf8', timeout: 3000 },
    ).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export type CursorFetch = (token: string) => Promise<CursorPeriodResponse | null>;

export interface CursorUsageDeps {
  fetchPeriod?: CursorFetch;
  accessToken?: () => string | null;
  membershipType?: () => string | undefined;
}

const defaultCursorFetch: CursorFetch = async (token) => {
  const res = await fetch(CURSOR_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: '{}',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return (await res.json()) as CursorPeriodResponse;
};

/**
 * Cursor's billing-cycle usage via DashboardService/GetCurrentPeriodUsage.
 * Cached under ~/.ateam/usage/cursor.json so a Status-tab poll does not
 * hammer the API, and so a brief offline stretch still shows the last read.
 */
export async function readCursorPlanUsage(
  now = Date.now(),
  deps: CursorUsageDeps = {},
): Promise<PlanUsage | null> {
  const cached = readSavedPlan(cursorUsageFile(), 'cursor', now);
  if (cached && now - cached.updatedAt < CURSOR_CACHE_MS) return cached;

  const token = (deps.accessToken ?? cursorAccessToken)();
  if (!token) return cached;

  try {
    const body = await (deps.fetchPeriod ?? defaultCursorFetch)(token);
    if (!body) return cached;
    const usage = cursorPlanFromResponse(
      body,
      (deps.membershipType ?? cursorMembershipType)(),
      now,
    );
    if (!usage) return cached;
    writeSavedPlan(cursorUsageFile(), usage);
    return usage;
  } catch {
    return cached;
  }
}

/** every provider we can still show a live window for, Claude → ChatGPT → Cursor */
export async function readAllPlanUsages(
  opts: { codexRolloutPath?: string; cursor?: CursorUsageDeps } = {},
  now = Date.now(),
): Promise<PlanUsage[]> {
  const plans: PlanUsage[] = [];
  const claude = readClaudePlanUsage(now);
  if (claude) plans.push(claude);

  // ChatGPT limits are account-wide: focused rollout → cache → newest rollout
  // on disk. Without the last fallthrough, leaving a Codex session wiped the
  // Status bars until the next Codex reply rewrote the cache.
  const codex =
    (opts.codexRolloutPath ? readCodexPlanUsage(opts.codexRolloutPath, now) : null) ??
    readCachedCodexPlanUsage(now) ??
    readCodexPlanUsage(newestCodexRolloutPath(), now);
  if (codex) plans.push(codex);

  const cursor = await readCursorPlanUsage(now, opts.cursor ?? {});
  if (cursor) plans.push(cursor);

  return plans;
}
