import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakePty = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[] }[],
}));

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    fakePty.calls.push({ file, args: [...args] });
    let onExit: ((event: { exitCode: number }) => void) | undefined;
    return {
      onData: () => ({ dispose: () => {} }),
      onExit: (callback: (event: { exitCode: number }) => void) => {
        onExit = callback;
        return { dispose: () => {} };
      },
      write: () => {},
      resize: () => {},
      kill: () => onExit?.({ exitCode: 0 }),
      pid: 1234,
    };
  },
}));

import { SessionManager } from './manager';

let root: string;
let cwd: string;
let cursorConfig: string;
let cursorBin: string;
let manager: SessionManager;

function cursorStore(chatId: string): void {
  const bucket = createHash('md5').update(resolve(cwd)).digest('hex');
  const chatDir = join(cursorConfig, 'chats', bucket, chatId);
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(chatDir, 'store.db'), '');
  writeFileSync(
    join(chatDir, 'meta.json'),
    JSON.stringify({ cwd: resolve(cwd), createdAtMs: Date.now(), updatedAtMs: Date.now() }),
  );
}

function spawnCursor(resumeSessionId?: string) {
  return manager.spawn({
    projectName: 'Cursor fixture',
    agentName: 'Cursor fixture',
    role: 'coder',
    workspace: { id: 'cursor-fixture', name: 'Cursor fixture', root: cwd },
    providerId: 'cursor',
    ...(resumeSessionId ? { resumeSessionId } : {}),
  });
}

function pluginDirFrom(args: string[]): string {
  const dir = args[args.indexOf('--plugin-dir') + 1];
  if (!dir) throw new Error('Cursor plugin directory is missing from argv.');
  return dir;
}

function firstPtyArgs(): string[] {
  const call = fakePty.calls[0];
  if (!call) throw new Error('Cursor PTY was not spawned.');
  return call.args;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
  root = mkdtempSync(join(tmpdir(), 'ateam-cursor-resume-'));
  cwd = join(root, 'project');
  cursorConfig = join(root, 'cursor-config');
  cursorBin = join(root, 'bin');
  mkdirSync(cwd);
  mkdirSync(cursorBin);
  const cli = join(cursorBin, 'cursor-agent');
  writeFileSync(cli, '#!/bin/sh\nexit 0\n');
  chmodSync(cli, 0o755);
  vi.stubEnv('ATEAM_HOME', join(root, 'ateam-home'));
  vi.stubEnv('CURSOR_CONFIG_DIR', cursorConfig);
  vi.stubEnv('PATH', cursorBin);
  fakePty.calls = [];
  manager = new SessionManager();
});

afterEach(() => {
  manager.shutdown();
  for (const call of fakePty.calls) {
    const pluginArg = call.args.indexOf('--plugin-dir');
    const pluginDir = call.args[pluginArg + 1];
    if (pluginArg >= 0 && pluginDir) rmSync(pluginDir, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('Cursor session resume and linking', () => {
  it('resumes a real stored Cursor chat and deduplicates only within Cursor', () => {
    const chatId = randomUUID();
    cursorStore(chatId);

    const hibernated = manager.addHibernated({
      projectName: 'Cursor fixture',
      agentName: 'Cursor fixture',
      role: 'coder',
      dir: cwd,
      claudeSessionId: chatId,
      providerId: 'cursor',
    });
    const first = manager.wake(hibernated.sessionId);
    expect(first.sessionId).not.toBe(hibernated.sessionId);
    expect(fakePty.calls).toHaveLength(1);
    expect(fakePty.calls[0]?.file).toBe(join(cursorBin, 'cursor-agent'));
    expect(fakePty.calls[0]?.args[0]).toBe(`--resume=${chatId}`);
    expect(fakePty.calls[0]?.args[1]).toBe('--plugin-dir');
    const pluginDir = pluginDirFrom(firstPtyArgs());
    const servers = JSON.parse(readFileSync(join(pluginDir, 'mcp.json'), 'utf8')).mcpServers;
    expect(servers['ateam-tasks'].args).toContain(first.sessionId);
    expect(servers['ateam-peers'].args).toContain(first.sessionId);
    expect(servers['ateam-tasks'].args).not.toContain(chatId);

    const second = spawnCursor(chatId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(fakePty.calls).toHaveLength(1);
  });

  it('does not deduplicate a Cursor resume against another provider with the same id', () => {
    const chatId = randomUUID();
    cursorStore(chatId);
    const claude = manager.addHibernated({
      projectName: 'Cursor fixture',
      agentName: 'Claude fixture',
      role: 'coder',
      dir: cwd,
      claudeSessionId: chatId,
      providerId: 'claude',
    });

    const cursor = spawnCursor(chatId);
    expect(cursor.sessionId).not.toBe(claude.sessionId);
    expect(cursor.providerId).toBe('cursor');
    expect(fakePty.calls).toHaveLength(1);
    expect(fakePty.calls[0]?.args).toContain(`--resume=${chatId}`);
    const pluginDir = pluginDirFrom(firstPtyArgs());
    const servers = JSON.parse(readFileSync(join(pluginDir, 'mcp.json'), 'utf8')).mcpServers;
    expect(servers['ateam-peers'].args).toContain(cursor.sessionId);
  });

  it('links a fresh Cursor session to its real chat id once metadata appears', async () => {
    const session = spawnCursor();
    const placeholder = session.claudeSessionId;
    expect(fakePty.calls[0]?.args.some((arg) => arg.startsWith('--resume='))).toBe(false);

    const chatId = randomUUID();
    cursorStore(chatId);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(manager.get(session.sessionId)?.claudeSessionId).toBe(chatId);
    expect(manager.get(session.sessionId)?.claudeSessionId).not.toBe(placeholder);
  });

  it('does not cross-link one chat when two Cursor PTYs share the same cwd', async () => {
    const first = spawnCursor();
    const second = spawnCursor();
    const firstPlaceholder = first.claudeSessionId;
    const secondPlaceholder = second.claudeSessionId;

    cursorStore(randomUUID());
    await vi.advanceTimersByTimeAsync(4_000);

    expect(manager.get(first.sessionId)?.claudeSessionId).toBe(firstPlaceholder);
    expect(manager.get(second.sessionId)?.claudeSessionId).toBe(secondPlaceholder);
  });

  it('falls back to a fresh launch for a missing store and never sends a fake resume id', () => {
    const missing = randomUUID();
    const session = spawnCursor(missing);

    expect(fakePty.calls).toHaveLength(1);
    expect(fakePty.calls[0]?.args).not.toContain(`--resume=${missing}`);
    expect(session.claudeSessionId).toBe(missing);
  });
});
