import { createHash } from 'node:crypto';
import { type Dirent, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ClaudeSessionInfo } from '@ateam/contract';
import { getSessionOwners } from '../session-owners';

const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_META_BYTES = 64 * 1024;
const SPAWN_MATCH_WINDOW_MS = 60_000;
const MAX_CHAT_SCAN = 500;

interface CursorChatMeta {
  cwd?: unknown;
  createdAtMs?: unknown;
  updatedAtMs?: unknown;
  title?: unknown;
}

function cursorConfigRoot(): string {
  const custom = process.env.CURSOR_CONFIG_DIR?.trim();
  if (custom) return resolve(custom);

  if (
    process.platform !== 'win32' &&
    process.env.XDG_CONFIG_HOME?.trim() &&
    ['linux', 'freebsd', 'openbsd', 'netbsd'].includes(process.platform)
  ) {
    return join(resolve(process.env.XDG_CONFIG_HOME), 'cursor');
  }
  return join(homedir(), '.cursor');
}

function workspaceBucket(cwd: string): string {
  const digest = createHash('md5').update(resolve(cwd)).digest('hex');
  return join(cursorConfigRoot(), 'chats', digest);
}

function storePathInBucket(bucket: string, chatId: string): string {
  if (!CHAT_ID_RE.test(chatId)) return '';
  const chatDir = join(bucket, chatId);
  const store = join(chatDir, 'store.db');
  try {
    if (lstatSync(chatDir).isSymbolicLink()) return '';
    const info = lstatSync(store);
    return info.isFile() && !info.isSymbolicLink() ? store : '';
  } catch {
    return '';
  }
}

/** Chat directory for a Cursor CLI conversation. Empty when `chatId` is not a UUID. */
export function cursorChatDirectory(cwd: string, chatId: string): string {
  if (!CHAT_ID_RE.test(chatId)) return '';
  return join(workspaceBucket(cwd), chatId);
}

/** Title recorded in Cursor's `meta.json`, when that file is present and readable. */
export function cursorChatTitle(cwd: string, chatId: string): string {
  const dir = cursorChatDirectory(cwd, chatId);
  if (!dir) return '';
  const title = readChatMeta(dir)?.title;
  return typeof title === 'string' ? title.trim().slice(0, 200) : '';
}

/** ISO birth of the Cursor chat from `meta.json` (`createdAtMs`). */
export function cursorCreatedAt(cwd: string, chatId: string): string {
  const dir = cursorChatDirectory(cwd, chatId);
  if (!dir) return '';
  const ms = validEpochMs(readChatMeta(dir)?.createdAtMs);
  return ms === undefined ? '' : new Date(ms).toISOString();
}

/** ISO last touch from `meta.json` (`updatedAtMs`, else `createdAtMs`).
 *  store.db is SQLite and is never opened here — meta is enough for the
 *  recently-active filter / hibernate cutoff. */
export function cursorLastActiveAt(cwd: string, chatId: string): string {
  const dir = cursorChatDirectory(cwd, chatId);
  if (!dir) return '';
  const meta = readChatMeta(dir);
  const ms = validEpochMs(meta?.updatedAtMs) ?? validEpochMs(meta?.createdAtMs);
  return ms === undefined ? '' : new Date(ms).toISOString();
}

/** Return Cursor CLI's SQLite store only when the expected chat store exists. */
export function cursorChatStorePath(cwd: string, chatId: string): string {
  return storePathInBucket(workspaceBucket(cwd), chatId);
}

function readChatMeta(path: string): CursorChatMeta | undefined {
  const metaPath = join(path, 'meta.json');
  try {
    const info = lstatSync(metaPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_META_BYTES) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as CursorChatMeta;
  } catch {
    return undefined;
  }
}

/** Find a newly created Cursor CLI chat for this exact cwd. Multiple valid
 * unclaimed candidates are ambiguous and are never resolved by proximity.
 * Reads metadata only, never store.db. */
export function discoverCursorChat(
  cwd: string,
  spawnedAtMs: number,
  isClaimed: (chatId: string) => boolean,
): string | undefined {
  if (!Number.isFinite(spawnedAtMs)) return undefined;
  const absoluteCwd = resolve(cwd);
  const bucket = workspaceBucket(absoluteCwd);
  let entries: Dirent[];
  try {
    entries = readdirSync(bucket, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !CHAT_ID_RE.test(entry.name)) continue;
    const storePath = storePathInBucket(bucket, entry.name);
    if (!storePath) continue;

    let claimed = true;
    try {
      claimed = isClaimed(entry.name);
    } catch {
      // A failed ownership check is not proof that a chat is free to claim.
    }
    if (claimed) continue;

    const meta = readChatMeta(join(bucket, entry.name));
    if (meta?.cwd !== absoluteCwd || typeof meta.createdAtMs !== 'number') continue;
    if (!Number.isFinite(meta.createdAtMs)) continue;
    // Cursor creates this metadata after the CLI starts. Never claim a chat
    // that was already present at spawn time, even if it was active recently.
    const delta = meta.createdAtMs - spawnedAtMs;
    if (delta < 0 || delta > SPAWN_MATCH_WINDOW_MS) continue;
    candidates.push(entry.name);
  }

  return candidates.length === 1 ? candidates[0] : undefined;
}

/** List Cursor CLI chats from lightweight metadata only; store.db is SQLite
 * and is deliberately never opened. The scan is bounded to this cwd bucket. */
export function listCursorChats(cwd: string, limit = 30): ClaudeSessionInfo[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const safeLimit = Math.min(Math.floor(limit), 100);
  const absoluteCwd = resolve(cwd);
  const bucket = workspaceBucket(absoluteCwd);
  let entries: Dirent[];
  try {
    entries = readdirSync(bucket, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: Array<{ id: string; dir: string }> = [];
  let scanned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !CHAT_ID_RE.test(entry.name)) continue;
    if (scanned >= MAX_CHAT_SCAN) break;
    scanned++;
    const storePath = storePathInBucket(bucket, entry.name);
    if (!storePath) continue;
    const dir = join(bucket, entry.name);
    try {
      const metaStat = lstatSync(join(dir, 'meta.json'));
      if (!metaStat.isFile() || metaStat.isSymbolicLink() || metaStat.size > MAX_META_BYTES)
        continue;
      candidates.push({ id: entry.name, dir });
    } catch {
      // Missing or unreadable metadata is not a resumable listing entry.
    }
  }

  const rows: Array<Omit<ClaudeSessionInfo, 'humanId'>> = [];
  for (const candidate of candidates) {
    const meta = readChatMeta(candidate.dir);
    if (!meta || meta.cwd !== absoluteCwd) continue;
    const updatedAtMs = validEpochMs(meta.updatedAtMs);
    const createdAtMs = validEpochMs(meta.createdAtMs);
    const timestamp = updatedAtMs ?? createdAtMs;
    if (timestamp === undefined) continue;
    const title = typeof meta.title === 'string' ? meta.title.trim().slice(0, 200) : '';
    rows.push({
      id: candidate.id,
      mtime: new Date(timestamp).toISOString(),
      title,
      summary: '(no summary)',
      providerId: 'cursor',
    });
  }

  rows.sort((a, b) =>
    a.mtime === b.mtime ? a.id.localeCompare(b.id) : a.mtime < b.mtime ? 1 : -1,
  );
  const top = rows.slice(0, safeLimit);
  const owners = getSessionOwners(top.map((row) => row.id));
  return top.map((row) => (owners[row.id] ? { ...row, humanId: owners[row.id] } : row));
}

function validEpochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 8.64e15)
    return undefined;
  return value;
}
