import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  constants,
  accessSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Turn } from '@ateam/contract';
import type { NativeMigrationMessage, NativeMigrationResult } from '../native-migration-types';
import { toolInputSummary } from '../transcript-file';
import { cursorChatDirectory } from './cursor-sessions';

const MAX_BLOB_BYTES = 5_000_000;
const SQLITE_MAX_BUFFER = 64 * 1024 * 1024;

/** Bundled sidecar Node is 22.11 and has no `node:sqlite`. Opening the module
 * with `createRequire(import.meta.url)` also crashes the CJS bundle at load,
 * which takes the whole sidecar down. Talk to `store.db` only when a switch
 * or the stream view needs it, through the system `sqlite3` CLI. */
function sqliteBin(): string {
  const candidates =
    process.platform === 'win32'
      ? []
      : ['/usr/bin/sqlite3', '/usr/local/bin/sqlite3', '/opt/homebrew/bin/sqlite3'];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try the next location
    }
  }
  throw new Error('Cursor session migration needs the sqlite3 command-line tool.');
}

function sqliteJson(path: string, sql: string, readOnly = false): unknown[] {
  const args = readOnly ? ['-readonly', '-json', path] : ['-json', path];
  let out = '';
  try {
    out = execFileSync(sqliteBin(), args, {
      input: `.timeout 5000\n${sql}\n`,
      encoding: 'utf8',
      maxBuffer: SQLITE_MAX_BUFFER,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor chat store could not be read (${message})`);
  }
  if (!out.trim()) return [];
  const parsed: unknown = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [];
}

function sqliteExec(path: string, sql: string): void {
  try {
    execFileSync(sqliteBin(), [path], {
      input: `.timeout 5000\n${sql}\n`,
      encoding: 'utf8',
      maxBuffer: SQLITE_MAX_BUFFER,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor chat store could not be written (${message})`);
  }
}

function sqlBlob(data: Buffer): string {
  return `x'${data.toString('hex')}'`;
}

function readVarint(buf: Buffer, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length && shift <= 63n) {
    const byte = buf[i];
    if (byte === undefined) break;
    i += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: i };
    shift += 7n;
  }
  throw new Error('Cursor conversation record is truncated');
}

function encodeVarint(value: bigint): Buffer {
  const bytes: number[] = [];
  let n = value;
  while (n > 127n) {
    bytes.push(Number(n & 127n) | 0x80);
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function tag(field: number, wire: number): Buffer {
  return encodeVarint(BigInt((field << 3) | wire));
}

function bytesField(field: number, data: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), encodeVarint(BigInt(data.length)), data]);
}

function varintField(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), encodeVarint(BigInt(value))]);
}

/** Length-delimited values of one field. Other fields are skipped. */
function fieldBytes(buf: Buffer, fieldNo: number): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const key = readVarint(buf, i);
    i = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      i = readVarint(buf, i).next;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      i = len.next;
      const size = Number(len.value);
      if (size < 0 || i + size > buf.length)
        throw new Error('Cursor conversation record is truncated');
      const chunk = buf.subarray(i, i + size);
      i += size;
      if (field === fieldNo) out.push(chunk);
    } else {
      throw new Error('Cursor conversation record is not a prompt checkpoint');
    }
  }
  return out;
}

function blobId(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function contentText(role: string, content: unknown): string {
  if (typeof content === 'string') return role === 'system' ? '' : content;
  if (!Array.isArray(content)) return '';
  const lines: string[] = [];
  for (const part of content) {
    const item = asRecord(part);
    if (!item) continue;
    const type = typeof item.type === 'string' ? item.type : '';
    if (type === 'text' && typeof item.text === 'string' && item.text.trim()) lines.push(item.text);
    else if (type === 'reasoning' || type === 'redacted-reasoning') continue;
    else if (type === 'tool-call') {
      const name = typeof item.toolName === 'string' && item.toolName ? item.toolName : 'tool';
      const args =
        item.args === undefined
          ? ''
          : typeof item.args === 'string'
            ? item.args
            : JSON.stringify(item.args);
      lines.push(`[Historical tool call: ${name}]\n${args}`);
    } else if (type === 'tool-result') {
      const name = typeof item.toolName === 'string' ? item.toolName : '';
      const body =
        typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? '');
      lines.push(`[Historical tool result: ${name}]\n${body}`.trim());
    } else if (type === 'image') {
      lines.push(
        '[Historical image: retained in the original session transcript; inspect that source if needed.]',
      );
    }
  }
  return lines.join('\n\n');
}

const INJECTED_TAGS = [
  'user_info',
  'project_layout',
  'rules',
  'always_applied_workspace_rules',
  'agent_requestable_workspace_rules',
  'user_rules',
  'agent_skills',
  'available_skills',
  'cloud_instructions',
  'cloud_task_instructions',
  'open_and_recently_viewed_files',
  'system_reminder',
  'system-reminder',
  'instructions_update',
  'mcp_instructions',
  'mcp_file_system',
  'mcp_file_system_servers',
  'git_status',
  'agent_transcripts',
  'cursor_rules_context',
  'attached_files',
  'system_notification',
  'task_notification',
  'agent_notification',
];

function stripInjectedTags(text: string): string {
  let out = text;
  for (const tag of INJECTED_TAGS) {
    out = out.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'gi'), '');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function promptMessage(raw: unknown): { role: 'user' | 'assistant'; text: string } | undefined {
  const message = asRecord(raw);
  if (!message) return undefined;
  const cursor = asRecord(asRecord(message.providerOptions)?.cursor);
  if (cursor?.isSummary === true) return undefined;
  if (
    cursor &&
    ('requestContextCompleteness' in cursor || 'userInfoSummarizationEpoch' in cursor)
  ) {
    return undefined;
  }
  const role = message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return undefined;
  const text = contentText(role, message.content).trim();
  const visible = role === 'user' ? stripInjectedTags(text) : text;
  if (!visible) return undefined;
  return { role: role === 'user' ? 'user' : 'assistant', text: visible };
}

interface StoreMeta {
  agentId?: unknown;
  latestRootBlobId?: unknown;
  createdAt?: unknown;
  [key: string]: unknown;
}

function readStoreMeta(storePath: string): StoreMeta {
  const row = asRecord(sqliteJson(storePath, "SELECT value FROM meta WHERE key = '0'", true)[0]);
  const value = row?.value;
  if (typeof value !== 'string' || !value) throw new Error('Cursor chat store has no checkpoint');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'hex').toString('utf8'));
  } catch {
    throw new Error('Cursor chat store has no checkpoint');
  }
  const meta = asRecord(parsed);
  if (!meta) throw new Error('Cursor chat store has no checkpoint');
  return meta;
}

function loadBlob(storePath: string, id: string): Buffer | undefined {
  return loadBlobs(storePath, [id]).get(id);
}

/** One sqlite process per batch. A stream poll must not spawn a process per blob. */
function loadBlobs(storePath: string, ids: readonly string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const clean = ids.filter((id) => /^[0-9a-f]{64}$/.test(id));
  const batch = 64;
  for (let i = 0; i < clean.length; i += batch) {
    const slice = clean.slice(i, i + batch);
    const sql = `SELECT id, hex(data) AS data FROM blobs WHERE id IN (${slice
      .map((id) => `'${id}'`)
      .join(',')})`;
    for (const row of sqliteJson(storePath, sql, true)) {
      const record = asRecord(row);
      const id = record?.id;
      const data = record?.data;
      if (typeof id !== 'string' || typeof data !== 'string' || !data) continue;
      const buf = Buffer.from(data, 'hex');
      if (buf.length > MAX_BLOB_BYTES) continue;
      out.set(id, buf);
    }
  }
  return out;
}

function promptBlobIds(root: Buffer): string[] {
  const ids: string[] = [];
  for (const id of fieldBytes(root, 1)) {
    if (id.length === 32) ids.push(id.toString('hex'));
  }
  return ids;
}

function latestRoot(storePath: string): { root: Buffer; createdAt: number } | undefined {
  const meta = readStoreMeta(storePath);
  const rootId = typeof meta.latestRootBlobId === 'string' ? meta.latestRootBlobId : '';
  const root = rootId ? loadBlob(storePath, rootId) : undefined;
  if (!root) return undefined;
  const createdAt =
    typeof meta.createdAt === 'number' && Number.isFinite(meta.createdAt)
      ? meta.createdAt
      : Date.now();
  return { root, createdAt };
}

/** Model-visible history from a Cursor CLI `store.db`.
 * The latest checkpoint's `root_prompt_messages_json` blobs are the prompt
 * Cursor itself hydrates. System text, reasoning, and the leading injected
 * user preamble (the user message that sits immediately before the real one)
 * are left behind. Tool calls become labeled history, not live calls. */
export function readCursorMigrationMessages(storePath: string): NativeMigrationMessage[] {
  if (!storePath) throw new Error('Cursor chat store is missing');
  const checkpoint = latestRoot(storePath);
  if (!checkpoint)
    throw new Error('No model-visible user history is available for native migration');
  const ids = promptBlobIds(checkpoint.root);
  const blobs = loadBlobs(storePath, ids);
  const messages: NativeMigrationMessage[] = [];
  for (const id of ids) {
    const blob = blobs.get(id);
    if (!blob || blob[0] !== 0x7b) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob.toString('utf8'));
    } catch {
      continue;
    }
    const message = promptMessage(parsed);
    if (!message) continue;
    messages.push({
      role: message.role,
      text: message.text,
      at: new Date(checkpoint.createdAt + messages.length).toISOString(),
    });
  }
  if (!messages.some((message) => message.role === 'user' && message.text.trim())) {
    throw new Error('No model-visible user history is available for native migration');
  }
  return messages;
}

/** How many prompt blobs the latest checkpoint holds. Used to arm the live
 * tail so a resumed chat is not replayed as fresh turns. */
export function cursorPromptCount(storePath: string): number {
  if (!storePath) return 0;
  try {
    const checkpoint = latestRoot(storePath);
    return checkpoint ? promptBlobIds(checkpoint.root).length : 0;
  } catch {
    return 0;
  }
}

export interface CursorStreamPage {
  turns: Turn[];
  /** Index of the first prompt blob in this page. The stream view sends it
   * back as `beforeByte`; it is a message index, not a file offset. */
  fromIndex: number;
  hasMore: boolean;
  total: number;
}

const CURSOR_PAGE = 80;
const THINKING_CAP = 8000;
const TOOL_RESULT_CAP = 2000;

/** Project one page of Cursor's latest checkpoint into stream turns.
 * Field 1 of the root blob is the prompt Cursor hydrates. Tool calls stay
 * tool cards here; migration still flattens them into historical text.
 * A read failure is an empty page so the stream can fall back to the PTY. */
export function readCursorStreamPage(
  storePath: string,
  sessionId: string,
  endExclusive?: number,
): CursorStreamPage {
  const empty: CursorStreamPage = { turns: [], fromIndex: 0, hasMore: false, total: 0 };
  if (!storePath) return empty;
  try {
    const checkpoint = latestRoot(storePath);
    if (!checkpoint) return empty;
    const ids = promptBlobIds(checkpoint.root);
    const total = ids.length;
    const end =
      endExclusive === undefined ? total : Math.max(0, Math.min(total, Math.floor(endExclusive)));
    const start = Math.max(0, end - CURSOR_PAGE);
    const pageIds = ids.slice(start, end);
    const blobs = loadBlobs(storePath, pageIds);
    const turns: Turn[] = [];
    for (let i = 0; i < pageIds.length; i++) {
      const blob = blobs.get(pageIds[i] ?? '');
      if (!blob || blob[0] !== 0x7b) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(blob.toString('utf8'));
      } catch {
        continue;
      }
      const index = start + i;
      turns.push(
        ...streamTurns(
          parsed,
          sessionId,
          new Date(checkpoint.createdAt + index).toISOString(),
          index * 100,
        ),
      );
    }
    return { turns, fromIndex: start, hasMore: start > 0, total };
  } catch {
    return empty;
  }
}

function skipCursorFrame(message: Record<string, unknown>): boolean {
  const cursor = asRecord(asRecord(message.providerOptions)?.cursor);
  if (!cursor) return false;
  if (cursor.isSummary === true) return true;
  return 'requestContextCompleteness' in cursor || 'userInfoSummarizationEpoch' in cursor;
}

function displayUserText(text: string): string {
  const stripped = stripInjectedTags(text);
  const queries = [...stripped.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
  return queries.length > 0 ? queries.join('\n\n') : stripped;
}

function streamTurns(raw: unknown, sessionId: string, at: string, seqBase: number): Turn[] {
  const message = asRecord(raw);
  if (!message || skipCursorFrame(message)) return [];
  const role = message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return [];
  const out: Turn[] = [];
  const push = (turn: Omit<Turn, 'seq' | 'sessionId' | 'at'>): void => {
    out.push({ seq: seqBase + out.length, sessionId, at, ...turn });
  };
  const speak = (text: string): void => {
    const visible = role === 'user' ? displayUserText(text) : text.trim();
    if (!visible) return;
    push({
      role: role === 'assistant' ? 'assistant' : role === 'tool' ? 'tool' : 'user',
      text: visible,
      kind: 'text',
    });
  };
  const content = message.content;
  if (typeof content === 'string') {
    speak(content);
    return out;
  }
  if (!Array.isArray(content)) return [];
  for (const part of content) {
    const item = asRecord(part);
    if (!item) continue;
    const type = typeof item.type === 'string' ? item.type : '';
    if (type === 'text' && typeof item.text === 'string') {
      speak(item.text);
    } else if (type === 'reasoning' || type === 'redacted-reasoning') {
      const text =
        typeof item.text === 'string'
          ? item.text
          : typeof item.reasoning === 'string'
            ? item.reasoning
            : '';
      const trimmed = text.trim();
      if (!trimmed) continue;
      push({
        role: 'assistant',
        text: trimmed.length > THINKING_CAP ? `${trimmed.slice(0, THINKING_CAP)}…` : trimmed,
        kind: 'thinking',
      });
    } else if (type === 'tool-call') {
      const name = typeof item.toolName === 'string' && item.toolName ? item.toolName : 'tool';
      const args = item.args;
      const full = name === 'AskUserQuestion' ? JSON.stringify(args ?? {}) : '';
      const desc = asRecord(args)?.description;
      push({
        role: 'tool',
        text: full ? full.slice(0, 6000) : toolInputSummary(args),
        kind: 'tool_use',
        toolName: name,
        ...(typeof item.toolCallId === 'string' && item.toolCallId
          ? { toolUseId: item.toolCallId }
          : {}),
        ...(typeof desc === 'string' && desc.trim() ? { label: desc.trim().slice(0, 120) } : {}),
      });
    } else if (type === 'tool-result') {
      const body =
        typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? '');
      const text = body.trim();
      push({
        role: 'tool',
        text: text.length > TOOL_RESULT_CAP ? `${text.slice(0, TOOL_RESULT_CAP)}…` : text,
        kind: 'tool_result',
        ...(typeof item.toolName === 'string' && item.toolName ? { toolName: item.toolName } : {}),
        ...(typeof item.toolCallId === 'string' && item.toolCallId
          ? { toolUseId: item.toolCallId }
          : {}),
      });
    } else if (type === 'image') {
      push({ role: role === 'assistant' ? 'assistant' : 'user', text: '[Image]', kind: 'text' });
    }
  }
  return out;
}

function promptJson(role: 'user' | 'assistant', text: string, id: string): Buffer {
  const body =
    role === 'user'
      ? { role, content: [{ type: 'text', text }], providerOptions: { cursor: { requestId: id } } }
      : {
          role,
          content: [{ type: 'text', text }],
          id,
          providerOptions: { cursor: { modelProviderMessageId: id } },
        };
  return Buffer.from(JSON.stringify(body));
}

function userProto(text: string, messageId: string, atMs: number): Buffer {
  return Buffer.concat([
    bytesField(1, Buffer.from(text)),
    bytesField(2, Buffer.from(messageId)),
    varintField(4, 1),
    bytesField(17, Buffer.from(messageId)),
    varintField(25, atMs),
    varintField(26, atMs),
  ]);
}

function assistantStep(text: string, atMs: number): Buffer {
  const message = Buffer.concat([
    bytesField(1, Buffer.from(text)),
    varintField(2, atMs),
    varintField(3, atMs),
  ]);
  return bytesField(1, message);
}

interface MigrationTurn {
  user: NativeMigrationMessage;
  assistants: NativeMigrationMessage[];
}

function groupTurns(messages: readonly NativeMigrationMessage[]): MigrationTurn[] {
  const turns: MigrationTurn[] = [];
  for (const message of messages) {
    if (!message.text.trim()) continue;
    if (message.role === 'user') turns.push({ user: message, assistants: [] });
    else if (turns.length > 0) turns[turns.length - 1]?.assistants.push(message);
  }
  return turns;
}

/** Write a Cursor CLI chat whose checkpoint carries the migrated prompt and
 * one turn per user message, so `cursor-agent --resume=<id>` can continue it. */
export function writeCursorSessionImport(
  messages: readonly NativeMigrationMessage[],
  cwd: string,
): NativeMigrationResult {
  if (!isAbsolute(cwd)) throw new Error('Cursor import requires an absolute cwd');
  const turns = groupTurns(messages);
  if (turns.length === 0) throw new Error('Cannot migrate a session without user history');
  const sessionId = randomUUID();
  const dir = cursorChatDirectory(cwd, sessionId);
  if (!dir) throw new Error('Cursor import could not allocate a chat id');
  const storePath = join(dir, 'store.db');
  const atMs = Date.now();
  const absoluteCwd = resolve(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const statements = [
    'PRAGMA journal_mode = DELETE;',
    'PRAGMA synchronous = NORMAL;',
    'PRAGMA user_version = 1;',
    'CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB);',
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);',
    'BEGIN;',
  ];
  try {
    const seen = new Set<string>();
    const put = (data: Buffer): Buffer => {
      const id = blobId(data);
      const hex = id.toString('hex');
      // Blob ids are the content hash. Repeated replies share one row; inserting
      // the same id again aborts the whole import.
      if (!seen.has(hex)) {
        seen.add(hex);
        statements.push(`INSERT INTO blobs (id, data) VALUES ('${hex}', ${sqlBlob(data)});`);
      }
      return id;
    };
    const jsonIds: Buffer[] = [];
    const turnIds: Buffer[] = [];
    for (const message of messages) {
      if (!message.text.trim()) continue;
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      jsonIds.push(put(promptJson(message.role, message.text, randomUUID())));
    }
    for (const turn of turns) {
      const requestId = randomUUID();
      const userId = put(userProto(turn.user.text, requestId, atMs));
      const stepIds = turn.assistants.map((message) => put(assistantStep(message.text, atMs)));
      const structure = Buffer.concat([
        bytesField(1, userId),
        ...stepIds.map((id) => bytesField(2, id)),
        bytesField(3, Buffer.from(requestId)),
        bytesField(10, Buffer.from(requestId)),
      ]);
      turnIds.push(put(bytesField(1, structure)));
    }
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const state = Buffer.concat([
      ...jsonIds.map((id) => bytesField(1, id)),
      ...turnIds.map((id) => bytesField(8, id)),
      bytesField(9, Buffer.from(`file://${absoluteCwd}`)),
      varintField(10, 1),
      bytesField(22, Buffer.from('cli')),
      varintField(26, atMs),
      bytesField(27, Buffer.from(zone)),
    ]);
    const rootId = put(state);
    const metadata = {
      agentId: sessionId,
      latestRootBlobId: rootId.toString('hex'),
      name: 'New Agent',
      mode: 'default',
      isRunEverything: false,
      createdAt: atMs,
      lastUsedModel: 'default',
      blobEncryptionKey: randomBytes(32).toString('hex'),
    };
    statements.push(
      `INSERT INTO meta (key, value) VALUES ('0', '${Buffer.from(JSON.stringify(metadata), 'utf8').toString('hex')}');`,
      'COMMIT;',
    );
    sqliteExec(storePath, statements.join('\n'));
    chmodSync(storePath, 0o600);
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        schemaVersion: 1,
        createdAtMs: atMs,
        hasConversation: true,
        title: '',
        updatedAtMs: atMs,
        cwd: absoluteCwd,
      }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { sessionId, path: storePath };
}

/** Record the inherited display name where Cursor reads it: `meta.json` and
 * the checkpoint metadata. Source records are not rewritten. */
export function renameCursorImportedSession(storePath: string, sessionName: string): void {
  const name = sessionName.trim().slice(0, 200);
  if (!name || !storePath) return;
  const metaPath = join(dirname(storePath), 'meta.json');
  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    meta = {};
  }
  meta.title = name;
  meta.updatedAtMs = Date.now();
  writeFileSync(metaPath, JSON.stringify(meta), { encoding: 'utf8', mode: 0o600 });
  const row = asRecord(sqliteJson(storePath, "SELECT value FROM meta WHERE key = '0'")[0]);
  if (typeof row?.value !== 'string' || !row.value) return;
  const checkpoint = JSON.parse(Buffer.from(row.value, 'hex').toString('utf8')) as Record<
    string,
    unknown
  >;
  checkpoint.name = name;
  sqliteExec(
    storePath,
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('0', '${Buffer.from(JSON.stringify(checkpoint), 'utf8').toString('hex')}');`,
  );
}
