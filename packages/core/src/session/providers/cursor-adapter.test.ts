import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergedPath } from '../../platform';
import { peerMcpServer, taskMcpServer } from '../mcp-config';
import { cursorAdapter, requireCursorBin, resolveCursorBin } from './cursor-adapter';
import { getAdapter } from './index';
import type { ProviderBuildArgs } from './provider-adapter';

const roots: string[] = [];
const pluginDirs: string[] = [];
function executable(dir: string, name = 'cursor-agent'): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

function pluginDirFrom(args: string[]): string {
  const dir = args[args.indexOf('--plugin-dir') + 1];
  if (!dir) throw new Error('Cursor plugin directory is missing from argv.');
  return dir;
}

afterEach(() => {
  for (const path of pluginDirs.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const buildArgs = (overrides: Partial<ProviderBuildArgs> = {}) =>
  cursorAdapter.buildArgs({
    sessionId: 'ateam-session',
    sessionName: 'ignored name',
    cwd: '/project',
    appendSystemPrompt: '',
    settingsJson: '{"ignored":true}',
    mcpConfigPath: '',
    model: 'claude-opus',
    ...overrides,
  });

describe('Cursor CLI provider adapter', () => {
  it('is registered as the Cursor provider and resolves cursor-agent from PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-cursor-path-'));
    roots.push(root);
    const bin = executable(join(root, 'bin'));
    expect(resolveCursorBin({ path: join(root, 'bin'), home: root, loginPath: '' })).toBe(bin);
    expect(getAdapter('cursor')).toBe(cursorAdapter);
  });

  it('finds ~/.local/bin/cursor-agent even when the process PATH is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-cursor-home-'));
    roots.push(root);
    const bin = executable(join(root, '.local', 'bin'));
    expect(resolveCursorBin({ path: '', home: root, loginPath: '' })).toBe(bin);
  });

  it('also searches the login-shell PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-cursor-login-'));
    roots.push(root);
    const bin = executable(join(root, 'login-bin'));
    expect(
      resolveCursorBin({
        path: '',
        home: join(root, 'empty-home'),
        loginPath: join(root, 'login-bin'),
      }),
    ).toBe(bin);
  });

  it.each(['PATH', '~/.local/bin', 'login-shell PATH'])(
    'recognizes the agent alias from %s only when it resolves into Cursor’s versioned install',
    (source) => {
      const root = mkdtempSync(join(tmpdir(), 'ateam-cursor-agent-alias-'));
      roots.push(root);
      const installDir = join(root, 'share', 'cursor-agent', 'versions', 'test-version');
      const target = executable(installDir);
      const aliasDir =
        source === '~/.local/bin' ? join(root, '.local', 'bin') : join(root, 'alias-bin');
      mkdirSync(aliasDir, { recursive: true });
      const alias = join(aliasDir, 'agent');
      symlinkSync(target, alias);

      const options =
        source === 'PATH'
          ? { path: aliasDir, home: join(root, 'empty-home'), loginPath: '' }
          : source === '~/.local/bin'
            ? { path: '', home: root, loginPath: '' }
            : { path: '', home: join(root, 'empty-home'), loginPath: aliasDir };
      expect(resolveCursorBin(options)).toBe(alias);
    },
  );

  it('rejects an unrelated executable named agent', () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-unrelated-agent-'));
    roots.push(root);
    const binDir = join(root, 'bin');
    executable(binDir, 'agent');
    expect(resolveCursorBin({ path: binDir, home: join(root, 'empty-home'), loginPath: '' })).toBe(
      undefined,
    );
  });

  it('prefers cursor-agent over an agent alias and searches it before alias fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-cursor-priority-'));
    roots.push(root);
    const pathDir = join(root, 'path-bin');
    const localDir = join(root, '.local', 'bin');
    const loginDir = join(root, 'login-bin');
    const target = executable(join(root, 'share', 'cursor-agent', 'versions', 'v1'));
    mkdirSync(pathDir, { recursive: true });
    symlinkSync(target, join(pathDir, 'agent'));
    const localCli = executable(localDir, 'cursor-agent');
    const loginCli = executable(loginDir, 'cursor-agent');

    expect(resolveCursorBin({ path: pathDir, home: root, loginPath: loginDir })).toBe(localCli);
    rmSync(localCli);
    expect(resolveCursorBin({ path: pathDir, home: root, loginPath: loginDir })).toBe(loginCli);
  });

  it('builds fresh and resumed argv with only verified Cursor flags', () => {
    expect(buildArgs()).toEqual([]);
    expect(buildArgs({ initialPrompt: 'Start this task' })).toEqual(['Start this task']);
    expect(buildArgs({ resumeSessionId: 'cursor-thread-1' })).toEqual(['--resume=cursor-thread-1']);
    expect(buildArgs({ resumeSessionId: 'cursor-thread-1', initialPrompt: 'Continue' })).toEqual([
      '--resume=cursor-thread-1',
      'Continue',
    ]);

    const args = buildArgs({
      resumeSessionId: 'thread',
      forkSession: true,
      model: 'gpt-5.6-sol',
      appendSystemPrompt: 'secret recall',
      settingsJson: '{"dangerous":true}',
      mcpConfigPath: '',
    });
    // Resume alone must not submit recall as a new user turn.
    expect(args).toEqual(['--resume=thread']);
    expect(args.join(' ')).not.toMatch(
      /--(?:force|trust|approve-mcps|session-id|name|append-system-prompt|mcp-config|settings)/,
    );
  });

  it('folds Human recall into the positional prompt on fresh launch and with an existing first message', () => {
    const fresh = buildArgs({ appendSystemPrompt: 'skills index' });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toContain('<ateam_human_recall>');
    expect(fresh[0]).toContain('skills index');
    expect(fresh[0]).toContain('</ateam_human_recall>');

    const withBody = buildArgs({
      appendSystemPrompt: 'skills index',
      initialPrompt: 'Continue the migrated task',
    });
    expect(withBody[0]).toMatch(
      /<ateam_human_recall>\s*skills index\s*<\/ateam_human_recall>\s*\n\nContinue the migrated task/,
    );

    const resumedWithBody = buildArgs({
      resumeSessionId: 'thread',
      appendSystemPrompt: 'skills index',
      initialPrompt: 'Continue',
    });
    expect(resumedWithBody[0]).toBe('--resume=thread');
    expect(resumedWithBody[1]).toContain('<ateam_human_recall>');
    expect(resumedWithBody[1]).toContain('Continue');
  });

  it('mounts the existing session MCP config through a private plugin directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-cursor-plugin-spec-'));
    roots.push(root);
    const ateamHome = join(root, 'ateam-home');
    const cwd = join(root, 'same project');
    const sessionId = 'cursor-plugin-session-a';
    vi.stubEnv('ATEAM_HOME', ateamHome);
    vi.stubEnv('PATH', join(root, 'path-bin'));
    const configPath = join(root, 'session-mcp.json');
    const tasks = taskMcpServer(sessionId, cwd);
    const peers = peerMcpServer(sessionId);
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          'ateam-tasks': { ...tasks, env: { ATEAM_HOME: 'wrong-home', TASK_FLAG: 'kept' } },
          'ateam-peers': peers,
          'ateam-chat': {
            command: process.execPath,
            args: ['/bundle/mcp-chat.cjs', '--chat', 'chat-a', '--session', sessionId],
          },
          codegraph: { command: '/bundle/codegraph', args: ['serve', '--mcp'] },
        },
      }),
    );

    const argv = buildArgs({
      sessionId: 'cursor-provider-chat',
      ateamSessionId: sessionId,
      cwd,
      mcpConfigPath: configPath,
      resumeSessionId: 'real-cursor-chat-id',
      initialPrompt: 'Continue the task',
    });
    expect(argv[0]).toBe('--resume=real-cursor-chat-id');
    expect(argv[1]).toBe('--plugin-dir');
    expect(argv[3]).toBe('Continue the task');
    const pluginDir = pluginDirFrom(argv);
    pluginDirs.push(pluginDir);
    const manifest = JSON.parse(
      readFileSync(join(pluginDir, '.cursor-plugin', 'plugin.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({
      name: 'ateam-session',
      version: '0.1.0',
      mcpServers: './mcp.json',
    });
    const config = JSON.parse(readFileSync(join(pluginDir, 'mcp.json'), 'utf8')).mcpServers;
    expect(Object.keys(config).sort()).toEqual([
      'ateam-chat',
      'ateam-peers',
      'ateam-tasks',
      'codegraph',
    ]);
    expect(config['ateam-tasks'].command).toBe(tasks.command);
    expect(config['ateam-tasks'].args).toEqual(tasks.args);
    expect(config['ateam-tasks'].env).toMatchObject({
      ATEAM_HOME: ateamHome,
      TASK_FLAG: 'kept',
    });
    expect(config['ateam-tasks'].env.PATH).toBe(mergedPath());
    expect(config['ateam-peers'].args).toEqual(peers.args);
    expect(config['ateam-chat'].args).toContain('chat-a');
    expect(config.codegraph.args).toEqual(['serve', '--mcp']);
    expect(statSync(pluginDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(pluginDir, '.cursor-plugin')).mode & 0o777).toBe(0o700);
    expect(statSync(join(pluginDir, 'mcp.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(pluginDir, '.cursor-plugin', 'plugin.json')).mode & 0o777).toBe(0o600);
  });

  it('does not invent chat or codegraph servers absent from the generated session config', () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-cursor-plugin-minimal-'));
    roots.push(root);
    const sessionId = 'cursor-plugin-minimal-session';
    const tasks = taskMcpServer(sessionId, root);
    const peers = peerMcpServer(sessionId);
    const configPath = join(root, 'session-mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { 'ateam-tasks': tasks, 'ateam-peers': peers } }),
    );

    const argv = buildArgs({
      sessionId,
      ateamSessionId: sessionId,
      cwd: root,
      mcpConfigPath: configPath,
    });
    const pluginDir = pluginDirFrom(argv);
    pluginDirs.push(pluginDir);
    const servers = JSON.parse(readFileSync(join(pluginDir, 'mcp.json'), 'utf8')).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(['ateam-peers', 'ateam-tasks']);
  });

  it('isolates plugin directories and ATeam session ids for concurrent sessions in one cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-cursor-plugin-isolation-'));
    roots.push(root);
    const cwd = join(root, 'shared-project');
    const makeConfig = (sessionId: string) => {
      const path = join(root, `${sessionId}.json`);
      writeFileSync(
        path,
        JSON.stringify({ mcpServers: { 'ateam-tasks': taskMcpServer(sessionId, cwd) } }),
      );
      return path;
    };
    const firstId = 'cursor-session-a';
    const secondId = 'cursor-session-b';
    const firstArgs = buildArgs({
      sessionId: firstId,
      ateamSessionId: firstId,
      cwd,
      mcpConfigPath: makeConfig(firstId),
    });
    const secondArgs = buildArgs({
      sessionId: secondId,
      ateamSessionId: secondId,
      cwd,
      mcpConfigPath: makeConfig(secondId),
    });
    const firstDir = pluginDirFrom(firstArgs);
    const secondDir = pluginDirFrom(secondArgs);
    pluginDirs.push(firstDir, secondDir);
    expect(firstDir).not.toBe(secondDir);
    const firstServers = JSON.parse(readFileSync(join(firstDir, 'mcp.json'), 'utf8')).mcpServers;
    const secondServers = JSON.parse(readFileSync(join(secondDir, 'mcp.json'), 'utf8')).mcpServers;
    expect(firstServers['ateam-tasks'].args).toContain(firstId);
    expect(firstServers['ateam-tasks'].args).not.toContain(secondId);
    expect(secondServers['ateam-tasks'].args).toContain(secondId);
    expect(secondServers['ateam-tasks'].args).not.toContain(firstId);
  });

  it('does not mount MCP without a config and reports missing or malformed configs', () => {
    expect(buildArgs({ mcpConfigPath: '' })).toEqual([]);
    const root = mkdtempSync(join(tmpdir(), 'ateam-cursor-plugin-invalid-'));
    roots.push(root);
    const missing = join(root, 'missing.json');
    expect(() => buildArgs({ mcpConfigPath: missing })).toThrow(
      /Cursor MCP config is missing or invalid/,
    );
    const malformed = join(root, 'malformed.json');
    writeFileSync(malformed, '{broken');
    expect(() => buildArgs({ mcpConfigPath: malformed })).toThrow(
      /Cursor MCP config is missing or invalid/,
    );
    const incomplete = join(root, 'incomplete.json');
    writeFileSync(incomplete, JSON.stringify({ other: true }));
    expect(() => buildArgs({ mcpConfigPath: incomplete })).toThrow(
      /Cursor MCP config is missing or invalid/,
    );
  });

  it('reports a clear missing-CLI error and never treats the GUI cursor command as a fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-cursor-gui-only-'));
    roots.push(root);
    executable(join(root, 'bin'), 'cursor');
    const search = () =>
      resolveCursorBin({ path: join(root, 'bin'), home: join(root, 'missing'), loginPath: '' });
    expect(search()).toBeUndefined();
    expect(() => requireCursorBin(search)).toThrow(
      /Cursor CLI not found.*cursor-agent.*cursor.*not supported/i,
    );
  });
});
