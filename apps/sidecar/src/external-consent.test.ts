import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXTERNAL_TOOLS, ExternalAccess, type SessionManager } from '@ateam/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it, vi } from 'vitest';
import { build } from 'tsup';
import { startExternalMcp } from './external-mcp';

it('local stdio client discovers tools, triggers consent, gains only approved access and loses it on revocation', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-stdio-consent-')));
  const old = process.env.ATEAM_HOME;
  process.env.ATEAM_HOME = home;
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const access = new ExternalAccess(home, () => [home]);
  access.port = port;
  const source = resolve('apps/sidecar/src/mcp-desktop.ts');
  access.registerClaude(join(home, 'claude.json'), process.execPath, source);
  const manager = {
    listPeerSessions: () => [
      {
        id: 'real',
        name: 'Test session',
        provider: 'codex',
        projectDir: home,
        model: '',
        state: 'idle' as const,
      },
    ],
    deliverExternalMessage: vi.fn(() => false),
    externalReply: undefined,
  };
  const service = await startExternalMcp(manager as unknown as SessionManager, undefined, access);
  writeFileSync(
    join(home, 'external-mcp', 'endpoint.json'),
    JSON.stringify({ url: access.endpoint }),
  );
  const client = new Client({ name: 'desktop-spec', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          resolve('node_modules/tsx/dist/cli.mjs'),
          source,
          '--credential',
          join(home, 'external-mcp', 'claude-desktop.json'),
          '--home',
          home,
        ],
        stderr: 'pipe',
      }),
    );
    const instructions = client.getInstructions();
    const tools = (await client.listTools()).tools;
    expect(instructions).toContain('MCP direct-first');
    expect(instructions).toContain('Delegate only complex code implementation');
    expect(instructions).toContain('global MCP rules across all Humans');
    expect(instructions).toContain('same-model subagents');
    expect(instructions).toContain('If no reliable association is available, do not guess or block an otherwise authorized MCP task');
    expect(instructions).toContain('Adapt task difficulty');
    expect(instructions).toContain('read_session_memory');
    expect((instructions ?? '').length).toBeLessThan(8000);
    expect(tools.map((t) => t.name).sort()).toEqual(EXTERNAL_TOOLS.map((t) => t.name).sort());
    const cursorInstall = tools.find((t) => t.name === 'install_cursor_cli');
    expect(cursorInstall?.inputSchema.required).toEqual(['project_id']);
    expect(Object.keys((cursorInstall?.inputSchema.properties ?? {}) as Record<string, unknown>)).toEqual([
      'project_id',
    ]);
    expect(tools.find((t) => t.name === 'list_projects')?.description).toContain(
      'rediscover approved projects',
    );
    expect(tools.find((t) => t.name === 'list_sessions')?.description).toContain(
      'rediscover real sessions',
    );
    expect(tools.find((t) => t.name === 'send_message')?.description).toContain(
      'coordinator owns product scope and acceptance',
    );
    await vi.waitFor(() => expect(access.status().pending).toHaveLength(1));
    expect((await client.callTool({ name: 'list_sessions', arguments: {} })).isError).toBe(true);
    access.decide('claude-desktop', true, [home]);
    const reply = await client.callTool({ name: 'list_sessions', arguments: {} });
    expect(reply.isError).not.toBe(true);
    expect(JSON.stringify(reply)).toContain('Test session');
    access.revoke('claude-desktop');
    expect((await client.callTool({ name: 'list_sessions', arguments: {} })).isError).toBe(true);
    const token = JSON.parse(
      readFileSync(join(home, 'external-mcp', 'claude-desktop.json'), 'utf8'),
    ).token;
    const unauthorized = await fetch(access.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(unauthorized.status).toBe(403);
  } finally {
    await client.close();
    await service.close();
    if (old === undefined) Reflect.deleteProperty(process.env, 'ATEAM_HOME');
    else process.env.ATEAM_HOME = old;
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);

it('launches the registered Cursor Desktop connector entry and enforces Ateam consent', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-cursor-consent-')));
  const old = process.env.ATEAM_HOME;
  process.env.ATEAM_HOME = home;
  let service: Awaited<ReturnType<typeof startExternalMcp>> | undefined;
  let client: Client | undefined;
  const reservation = createServer();
  try {
    await build({
      entry: [resolve('apps/sidecar/src/mcp-desktop.ts')],
      outDir: join(home, 'bundle'),
      format: ['cjs'],
      platform: 'node',
      target: 'node22',
      clean: true,
      dts: false,
      noExternal: [/^(?!node-pty$).*/],
      external: ['node-pty'],
      outExtension: () => ({ js: '.cjs' }),
    });
    const script = join(home, 'bundle', 'mcp-desktop.cjs');
    const config = join(home, '.cursor', 'mcp.json');
    const access = new ExternalAccess(home, () => [home]);
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    access.port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));

    access.registerCursorDesktop(config, process.execPath, script);
    const entry = JSON.parse(readFileSync(config, 'utf8')).mcpServers.ateam as {
      command: string;
      args: string[];
    };
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([
      script,
      '--credential',
      join(home, 'external-mcp', 'cursor-desktop.json'),
      '--home',
      home,
    ]);

    const manager = {
      listPeerSessions: () => [
        {
          id: 'cursor-fixture-session',
          name: 'Cursor fixture session',
          provider: 'cursor',
          projectDir: home,
          model: '',
          state: 'idle' as const,
        },
      ],
      deliverExternalMessage: vi.fn(() => false),
      externalReply: undefined,
    };
    service = await startExternalMcp(manager as unknown as SessionManager, undefined, access);
    writeFileSync(
      join(home, 'external-mcp', 'endpoint.json'),
      JSON.stringify({ url: access.endpoint }),
    );
    client = new Client({ name: 'cursor-desktop-fixture', version: '1' });
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, stderr: 'pipe' }));

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('list_sessions');
    expect(names).toContain('send_message');
    await vi.waitFor(() => expect(access.status().pending).toHaveLength(1));
    expect((await client.callTool({ name: 'list_sessions', arguments: {} })).isError).toBe(true);

    access.decide('cursor-desktop', true, [home]);
    const allowed = await client.callTool({ name: 'list_sessions', arguments: {} });
    expect(allowed.isError).not.toBe(true);
    expect(JSON.stringify(allowed)).toContain('Cursor fixture session');

    access.revoke('cursor-desktop');
    expect((await client.callTool({ name: 'list_sessions', arguments: {} })).isError).toBe(true);
  } finally {
    await client?.close();
    await service?.close();
    if (reservation.listening) await new Promise<void>((resolve) => reservation.close(() => resolve()));
    if (old === undefined) Reflect.deleteProperty(process.env, 'ATEAM_HOME');
    else process.env.ATEAM_HOME = old;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
