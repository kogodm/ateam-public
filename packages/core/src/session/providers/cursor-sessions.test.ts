import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInprocPair } from '@ateam/transport';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcClient } from '../../server/rpc-client';
import { createServer } from '../../server/rpc-server';
import { SessionManager } from '../manager';
import { storeResumePath, storeTranscriptPath } from '../provider-store';
import { recordSessionOwner } from '../session-owners';
import {
  cursorChatStorePath,
  cursorCreatedAt,
  cursorLastActiveAt,
  discoverCursorChat,
  listCursorChats,
} from './cursor-sessions';

const SPAWNED_AT = Date.now();
let tempRoot = '';

function setup(): { config: string; cwd: string; otherCwd: string } {
  tempRoot = mkdtempSync(join(tmpdir(), 'ateam-cursor-chats-'));
  const config = join(tempRoot, 'custom-cursor-config');
  const cwd = join(tempRoot, 'project');
  const otherCwd = join(tempRoot, 'other-project');
  mkdirSync(cwd);
  mkdirSync(otherCwd);
  vi.stubEnv('CURSOR_CONFIG_DIR', config);
  vi.stubEnv('ATEAM_HOME', join(tempRoot, 'ateam-home'));
  return { config, cwd, otherCwd };
}

function addChat(
  config: string,
  cwd: string,
  options: {
    id?: string;
    createdAtMs?: number;
    updatedAtMs?: number;
    title?: string;
    meta?: unknown;
  } = {},
) {
  const id = options.id ?? randomUUID();
  const bucket = createHash('md5').update(resolve(cwd)).digest('hex');
  const dir = join(config, 'chats', bucket, id);
  mkdirSync(dir, { recursive: true });
  // Empty fixture only: tests and production discovery never read SQLite data.
  writeFileSync(join(dir, 'store.db'), '');
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify(
      options.meta ?? {
        schemaVersion: 1,
        createdAtMs: options.createdAtMs ?? SPAWNED_AT,
        updatedAtMs: options.updatedAtMs ?? SPAWNED_AT,
        cwd: resolve(cwd),
        title: options.title ?? '',
      },
    ),
  );
  return id;
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

describe('Cursor CLI chat store', () => {
  it('returns only an existing store.db under the cwd workspace bucket', () => {
    const { config, cwd, otherCwd } = setup();
    const id = addChat(config, cwd);
    const otherId = addChat(config, otherCwd);

    expect(cursorChatStorePath(cwd, id)).toBe(
      join(config, 'chats', createHash('md5').update(resolve(cwd)).digest('hex'), id, 'store.db'),
    );
    expect(cursorChatStorePath(cwd, otherId)).toBe('');
    expect(cursorChatStorePath(cwd, randomUUID())).toBe('');
    expect(cursorChatStorePath(cwd, '../store.db')).toBe('');
  });

  it('reads createdAt / lastActiveAt from meta.json for the recently-active filter', () => {
    const { config, cwd } = setup();
    const created = SPAWNED_AT - 3 * 3600_000;
    const updated = SPAWNED_AT - 30 * 60_000;
    const id = addChat(config, cwd, { createdAtMs: created, updatedAtMs: updated });
    expect(cursorCreatedAt(cwd, id)).toBe(new Date(created).toISOString());
    expect(cursorLastActiveAt(cwd, id)).toBe(new Date(updated).toISOString());
    expect(cursorLastActiveAt(cwd, randomUUID())).toBe('');
  });

  it('discovers one recent unclaimed chat only in the matching workspace bucket', () => {
    const { config, cwd, otherCwd } = setup();
    const id = addChat(config, cwd);
    addChat(config, otherCwd);

    expect(discoverCursorChat(cwd, SPAWNED_AT, () => false)).toBe(id);
    expect(discoverCursorChat(cwd, SPAWNED_AT, (claimed) => claimed === id)).toBeUndefined();
  });

  it('does not bind pre-existing chats or chats with malformed metadata', () => {
    const { config, cwd } = setup();
    addChat(config, cwd, { createdAtMs: SPAWNED_AT - 1_000 });
    addChat(config, cwd, { meta: { createdAtMs: 'not-a-time', cwd: resolve(cwd) } });

    expect(discoverCursorChat(cwd, SPAWNED_AT, () => false)).toBeUndefined();
  });

  it('refuses multiple unclaimed concurrent chats instead of choosing the nearest', () => {
    const { config, cwd } = setup();
    const first = addChat(config, cwd, { createdAtMs: SPAWNED_AT + 100 });
    const second = addChat(config, cwd, { createdAtMs: SPAWNED_AT + 2_000 });

    expect(discoverCursorChat(cwd, SPAWNED_AT, () => false)).toBeUndefined();
    expect(discoverCursorChat(cwd, SPAWNED_AT, (id) => id === first)).toBe(second);
  });

  it('does not use Cursor SQLite as a transcript path', () => {
    const { config, cwd } = setup();
    const id = addChat(config, cwd);

    expect(storeResumePath('cursor', cwd, id)).toBe(cursorChatStorePath(cwd, id));
    expect(storeTranscriptPath('cursor', cwd, id)).toBe('');
    expect(storeResumePath('claude', cwd, id)).toBe(storeTranscriptPath('claude', cwd, id));
    expect(storeResumePath('codex', cwd, id)).toBe(storeTranscriptPath('codex', cwd, id));
  });

  it('handles absent workspace directories and redirected config roots', () => {
    const { config, cwd } = setup();
    const redirected = join(tempRoot, 'redirected-config');
    vi.stubEnv('CURSOR_CONFIG_DIR', redirected);
    expect(cursorChatStorePath(cwd, randomUUID())).toBe('');
    expect(discoverCursorChat(cwd, SPAWNED_AT, () => false)).toBeUndefined();

    const id = addChat(redirected, cwd);
    expect(cursorChatStorePath(cwd, id)).toContain(join(redirected, 'chats'));
    expect(discoverCursorChat(cwd, SPAWNED_AT, () => false)).toBe(id);
    expect(config).not.toBe(redirected);
  });

  it('lists matching Cursor chats by updated time and includes an ATeam owner when known', () => {
    const { config, cwd, otherCwd } = setup();
    const older = addChat(config, cwd, {
      createdAtMs: SPAWNED_AT - 5_000,
      updatedAtMs: SPAWNED_AT - 2_000,
      title: 'Older chat',
    });
    const newer = addChat(config, cwd, {
      createdAtMs: SPAWNED_AT - 10_000,
      updatedAtMs: SPAWNED_AT - 1_000,
      title: 'Newest chat',
    });
    const createdOnly = addChat(config, cwd, {
      meta: { cwd: resolve(cwd), createdAtMs: SPAWNED_AT - 3_000, title: 'Created only' },
    });
    addChat(config, otherCwd, { title: 'Other workspace' });
    recordSessionOwner(newer, 'human-cursor');

    const sessions = listCursorChats(cwd);
    expect(sessions.map((session) => session.id)).toEqual([newer, older, createdOnly]);
    expect(sessions[0]).toMatchObject({
      id: newer,
      mtime: new Date(SPAWNED_AT - 1_000).toISOString(),
      title: 'Newest chat',
      summary: '(no summary)',
      providerId: 'cursor',
      humanId: 'human-cursor',
    });
    expect(sessions[1]?.title).toBe('Older chat');
    expect(sessions[2]?.mtime).toBe(new Date(SPAWNED_AT - 3_000).toISOString());
  });

  it('skips malformed metadata and symlinked chat directories without reading stores', () => {
    const { config, cwd } = setup();
    const bucket = join(config, 'chats', createHash('md5').update(resolve(cwd)).digest('hex'));
    const malformed = addChat(config, cwd);
    const malformedDir = join(bucket, malformed);
    writeFileSync(join(malformedDir, 'meta.json'), '{bad json');
    const noTimestamp = addChat(config, cwd, { meta: { cwd: resolve(cwd), title: 'No time' } });
    const valid = addChat(config, cwd, { title: 'Valid' });
    const validDir = join(bucket, valid);
    const linked = randomUUID();
    symlinkSync(validDir, join(bucket, linked), 'dir');
    const linkedMeta = addChat(config, cwd);
    const linkedMetaDir = join(bucket, linkedMeta);
    unlinkSync(join(linkedMetaDir, 'meta.json'));
    symlinkSync(join(validDir, 'meta.json'), join(linkedMetaDir, 'meta.json'));

    expect(listCursorChats(cwd).map((session) => session.id)).toEqual([valid]);
    expect(listCursorChats(cwd).some((session) => session.id === noTimestamp)).toBe(false);
  });

  it('respects result limits and rejects invalid limits', () => {
    const { config, cwd } = setup();
    addChat(config, cwd, { title: 'One', updatedAtMs: SPAWNED_AT - 2 });
    addChat(config, cwd, { title: 'Two', updatedAtMs: SPAWNED_AT - 1 });

    expect(listCursorChats(cwd, 1)).toHaveLength(1);
    expect(listCursorChats(cwd, 0)).toEqual([]);
    expect(listCursorChats(cwd, Number.NaN)).toEqual([]);
  });

  it('includes Cursor CLI history in the existing claude.sessions Resume RPC', async () => {
    const { config, cwd } = setup();
    const id = addChat(config, cwd, { title: 'Resume this Cursor chat' });
    const sessions = new SessionManager();
    const server = createServer({
      sessions,
      synth: {} as never,
      storeRoot: join(tempRoot, 'ateam-home'),
    });
    const { client, server: port } = createInprocPair();
    server.attach(port);
    const rpc = new RpcClient(client);
    try {
      const response = await rpc.request<{
        sessions: Array<{ id: string; providerId?: string; title: string }>;
      }>('claude.sessions', { cwd });
      expect(response.sessions).toContainEqual(
        expect.objectContaining({ id, providerId: 'cursor', title: 'Resume this Cursor chat' }),
      );
    } finally {
      server.shutdown();
      sessions.shutdown();
    }
  });
});
