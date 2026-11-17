import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExternalAccess,
  ExternalConversations,
  ExternalExec,
  type CursorInstallDeps,
  type SessionManager,
} from '@ateam/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { conversationMcp, startExternalMcp } from './external-mcp';

it('connects linked run events and history through the external MCP service and stops publishing on close', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-mcp-live-runs-')));
  const oldHome = process.env.ATEAM_HOME;
  process.env.ATEAM_HOME = home;
  const projectPath = join(home, 'project');
  mkdirSync(projectPath);
  const project = realpathSync(projectPath);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const access = new ExternalAccess(home, () => [project]);
  access.port = port;
  access.touch('client', 'Test client');
  access.decide('client', true, [project]);
  const executeRequest = access.requestAccess('client', project, ['execute'], 'linked run test');
  access.decideRequest(executeRequest.request_id as string, true);
  const token = access.approved()[0]?.token;
  if (!token) throw new Error('Missing approved client token');
  const peers = [
    {
      id: 'runtime-a',
      stable_id: 'cli-session-a',
      name: 'A',
      provider: 'codex',
      projectDir: project,
      state: 'idle' as const,
      model: '',
    },
    {
      id: 'runtime-b',
      stable_id: 'cli-session-b',
      name: 'B',
      provider: 'claude',
      projectDir: project,
      state: 'idle' as const,
      model: '',
    },
  ];
  const sessions = Object.assign(new EventEmitter(), {
    listPeerSessions: () => peers,
    deliverExternalMessage: vi.fn(() => true),
    externalReply: undefined as SessionManager['externalReply'],
    externalRuns: undefined as SessionManager['externalRuns'],
  });
  const observed: { sessionId: string; run: { status: string; output: string } }[] = [];
  sessions.on('externalRun', (event) => observed.push(event));
  const service = await startExternalMcp(sessions as unknown as SessionManager, undefined, access);
  let serviceClosed = false;
  const client = new Client({ name: 'linked-run-integration', version: '1' });
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  const parse = (value: unknown) => {
    const text = (value as { content: { text: string }[] }).content[0]?.text;
    if (typeof text !== 'string') throw new Error('Missing MCP tool result');
    return JSON.parse(text) as Record<string, unknown>;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const instructions = client.getInstructions();
    expect(instructions).toContain('MCP direct-first');
    expect(instructions).toContain('Delegate only complex code implementation');
    expect(instructions).toContain('global MCP rules across all Humans');
    expect(instructions).toContain('same-model subagents');
    expect(instructions).toContain('If no reliable association is available, do not guess or block an otherwise authorized MCP task');
    const projects = parse(await client.callTool({ name: 'list_projects', arguments: {} }));
    const projectId = (projects.projects as { project_id: string }[])[0]?.project_id;
    if (!projectId) throw new Error('Missing authorized project');
    const result = parse(
      await client.callTool({
        name: 'run_command',
        arguments: {
          project_id: projectId,
          command: "printf 'password=SecretValue123'",
          session_id: 'cli-session-a',
        },
      }),
    );
    expect(result).toMatchObject({ status: 'exited', exit_code: 0, output: 'password=[redacted]' });
    expect(observed.map((event) => event.run.status)).toEqual(['running', 'exited']);
    expect(observed.every((event) => event.sessionId === 'runtime-a')).toBe(true);
    expect(JSON.stringify(observed)).not.toContain('SecretValue123');
    expect(sessions.externalRuns?.('runtime-a')).toMatchObject([
      { status: 'exited', output: 'password=[redacted]', sessionId: 'runtime-a' },
    ]);
    expect(sessions.externalRuns?.('runtime-b')).toEqual([]);

    void client
      .callTool({
        name: 'run_command',
        arguments: {
          project_id: projectId,
          command: "node -e \"setTimeout(() => process.stdout.write('late'), 800)\"",
          session_id: 'cli-session-a',
        },
      })
      .catch(() => {});
    await vi.waitFor(() =>
      expect(observed.filter((event) => event.run.status === 'running')).toHaveLength(2),
    );
    await client.close();
    await service.close();
    serviceClosed = true;
    const beforeLateExit = observed.length;
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(observed).toHaveLength(beforeLateExit);
    expect(sessions.externalRuns).toBeUndefined();
    expect(sessions.externalReply).toBeUndefined();
  } finally {
    await client.close().catch(() => {});
    if (!serviceClosed) await service.close();
    if (oldHome === undefined) Reflect.deleteProperty(process.env, 'ATEAM_HOME');
    else process.env.ATEAM_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

it('registers optional run links and associates authorized command executions without PTY input', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ateam-mcp-run-link-'));
  const projectPath = join(home, 'project');
  mkdirSync(projectPath);
  const project = realpathSync(projectPath);
  const access = new ExternalAccess(home, () => [project]);
  access.touch('client', 'Test client');
  access.decide('client', true, [project]);
  const request = access.requestAccess('client', project, ['execute', 'git_commit', 'git_push'], 'test');
  access.decideRequest(request.request_id as string, true);
  const peers = [
    {
      id: 'runtime-a',
      stable_id: 'cli-session-a',
      name: 'A',
      provider: 'codex',
      projectDir: project,
      state: 'idle' as const,
      model: '',
    },
    {
      id: 'runtime-b',
      stable_id: 'cli-session-b',
      name: 'B',
      provider: 'claude',
      projectDir: project,
      state: 'idle' as const,
      model: '',
    },
  ];
  const store = new ExternalConversations(home, [{ id: 'client', roots: [project] }], {
    list: () => peers,
    deliver: vi.fn(() => true),
  });
  const projectId = store.listProjects('client')[0]?.project_id;
  if (!projectId) throw new Error('Missing project fixture');
  const conversation = store.send('client', {
    project_id: projectId,
    session_id: 'cli-session-a',
    message: 'associate with A',
    idempotency_key: 'linked-run',
  });
  const updates: string[] = [];
  const exec = new ExternalExec(home, (run) => updates.push(run.status));
  const server = conversationMcp(store, 'client', { access, exec });
  const client = new Client({ name: 'run-link-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    for (const name of ['run_command', 'git_commit', 'git_push']) {
      const tool = tools.tools.find((item) => item.name === name);
      const schema = tool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(schema.properties).toHaveProperty('session_id');
      expect(schema.properties).toHaveProperty('conversation_id');
      expect(schema.required).not.toContain('session_id');
      expect(schema.required).not.toContain('conversation_id');
    }

    const linkedResult = await client.callTool({
      name: 'run_command',
      arguments: {
        project_id: projectId,
        command: 'echo linked',
        session_id: 'cli-session-a',
        conversation_id: conversation.conversation_id,
      },
    });
    expect(linkedResult.isError).toBeFalsy();
    expect(exec.listLinked('cli-session-a', 'runtime-a')[0]).toMatchObject({
      tool: 'run_command',
      output: expect.stringContaining('linked'),
    });
    expect(updates).toContain('running');
    expect(updates.at(-1)).toBe('exited');

    const beforeConflict = updates.length;
    const conflict = await client.callTool({
      name: 'run_command',
      arguments: {
        project_id: projectId,
        command: 'echo must-not-run',
        session_id: 'cli-session-b',
        conversation_id: conversation.conversation_id,
      },
    });
    expect(conflict.isError).toBe(true);
    expect(updates).toHaveLength(beforeConflict);
    expect(exec.listLinked('cli-session-b', 'runtime-b')).toEqual([]);

    const independent = await client.callTool({
      name: 'run_command',
      arguments: { project_id: projectId, command: 'echo independent' },
    });
    expect(independent.isError).toBeFalsy();
    expect(exec.listLinked('cli-session-a', 'runtime-a')).toHaveLength(1);
  } finally {
    await client.close();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it('registers Cursor installation as project execute-authorized and audited fixed work', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-mcp-cursor-install-')));
  const projectPath = join(home, 'project');
  mkdirSync(projectPath);
  const project = realpathSync(projectPath);
  const secondProjectPath = join(home, 'second-project');
  mkdirSync(secondProjectPath);
  const secondProject = realpathSync(secondProjectPath);
  const access = new ExternalAccess(home, () => [project, secondProject]);
  access.touch('client', 'Test client');
  access.decide('client', true, [project]);
  access.touch('client-2', 'Second test client');
  access.decide('client-2', true, [secondProject]);
  const store = new ExternalConversations(
    home,
    [
      { id: 'client', roots: [project] },
      { id: 'client-2', roots: [secondProject] },
    ],
    {
      list: () => [],
      deliver: () => true,
    },
  );
  const projectId = store.listProjects('client')[0]?.project_id;
  const secondProjectId = store.listProjects('client-2')[0]?.project_id;
  if (!projectId) throw new Error('Missing project fixture');
  if (!secondProjectId) throw new Error('Missing second project fixture');
  const start = vi.fn(async () => ({ status: 'running', execution_id: 'execution-1', output: '' }));
  const get = vi.fn(() => ({ status: 'running' }));
  const exec = { start, get } as unknown as ExternalExec;
  let releaseProbe!: () => void;
  let markProbeStarted!: () => void;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const probeStarted = new Promise<void>((resolve) => {
    markProbeStarted = resolve;
  });
  const installCursorCli = vi.fn(async (deps: CursorInstallDeps = {}) => {
    markProbeStarted();
    await probeGate;
    const run = await deps.runInstall?.('FIXED_INSTALL_SCRIPT', 180_000, '/merged/bin');
    if (typeof run === 'object')
      return { status: 'running' as const, executionId: run.executionId, output: run.output ?? '' };
    return { status: 'installed' as const, path: '/fake/cursor-agent', version: 'test-version', output: '' };
  });
  const server = conversationMcp(store, 'client', {
    access,
    exec,
    installCursorCli,
  });
  const client = new Client({ name: 'cursor-install-access-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const secondServer = conversationMcp(store, 'client-2', { access, exec, installCursorCli });
  const secondClient = new Client({ name: 'cursor-install-other-client-test', version: '1' });
  const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await secondServer.connect(secondServerTransport);
    await secondClient.connect(secondClientTransport);
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'install_cursor_cli');
    expect(tool?.inputSchema.required).toEqual(['project_id']);
    expect(Object.keys((tool?.inputSchema.properties ?? {}) as Record<string, unknown>)).toEqual(['project_id']);

    const denied = await client.callTool({ name: 'install_cursor_cli', arguments: { project_id: projectId } });
    expect(denied.isError).toBe(true);
    expect(installCursorCli).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();

    const request = access.requestAccess('client', project, ['execute'], 'install Cursor CLI');
    access.decideRequest(request.request_id as string, true);
    const ownerRequest = client.callTool({ name: 'install_cursor_cli', arguments: { project_id: projectId } });
    await probeStarted;

    // While the first authorized request is still in its asynchronous
    // installed/version probe, another client's request must see the lock.
    const secondDenied = await secondClient.callTool({
      name: 'install_cursor_cli',
      arguments: { project_id: secondProjectId },
    });
    expect(secondDenied.isError).toBe(true);
    expect(JSON.stringify(secondDenied)).not.toContain('execution-1');

    const secondRequest = access.requestAccess('client-2', secondProject, ['execute'], 'install Cursor CLI');
    access.decideRequest(secondRequest.request_id as string, true);
    const otherRequest = secondClient.callTool({
      name: 'install_cursor_cli',
      arguments: { project_id: secondProjectId },
    });
    const otherEarly = await Promise.race([
      otherRequest.then((result) => ({ kind: 'result' as const, result })),
      new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 500)),
    ]);
    releaseProbe();

    const allowed = await ownerRequest;
    const allowedContent = (allowed as { content: { type: string; text: string }[] }).content;
    const response = JSON.parse(allowedContent[0]?.type === 'text' ? allowedContent[0].text : '{}');
    expect(response).toEqual({ status: 'running', execution_id: 'execution-1' });
    expect(JSON.stringify(response)).not.toMatch(/FIXED_INSTALL_SCRIPT|cursor\.com/);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'install_cursor_cli',
        argv: ['bash', '-c', 'FIXED_INSTALL_SCRIPT'],
        displayCommand: 'Install Cursor CLI from official source',
        env: { PATH: '/merged/bin' },
      }),
    );
    const otherAllowed = otherEarly.kind === 'result' ? otherEarly.result : await otherRequest;
    expect(otherEarly.kind).toBe('result');
    const otherContent = (otherAllowed as { content: { type: string; text: string }[] }).content;
    const otherResponse = JSON.parse(otherContent[0]?.type === 'text' ? otherContent[0].text : '{}');
    expect(otherResponse).toEqual({ status: 'in_progress' });
    expect(JSON.stringify(otherResponse)).not.toContain('execution-1');
    expect(get).not.toHaveBeenCalledWith('client-2', 'execution-1');
    expect(start).toHaveBeenCalledTimes(1);
    expect(installCursorCli).toHaveBeenCalledTimes(1);

    const repeated = await client.callTool({ name: 'install_cursor_cli', arguments: { project_id: projectId } });
    const repeatedContent = (repeated as { content: { type: string; text: string }[] }).content;
    expect(JSON.parse(repeatedContent[0]?.type === 'text' ? repeatedContent[0].text : '{}')).toEqual({
      status: 'running',
      execution_id: 'execution-1',
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(installCursorCli).toHaveBeenCalledTimes(1);
  } finally {
    releaseProbe();
    await client.close();
    await server.close();
    await secondClient.close();
    await secondServer.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it('serves authenticated MCP conversations for concurrent clients, then revokes without stopping sessions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ateam-http-mcp-test-'));
  const oldHome = process.env.ATEAM_HOME;
  process.env.ATEAM_HOME = home;
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const tokens = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  const path = join(home, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      port,
      clients: tokens.map((token, i) => ({ id: `client${i}`, token, projects: [home] })),
    }),
    { mode: 0o600 },
  );
  const peer = {
    id: 'real-session',
    name: 'Coder',
    provider: 'codex',
    projectDir: home,
    state: 'idle' as const,
    model: '',
  };
  const manager = {
    listPeerSessions: () => [peer],
    deliverExternalMessage: vi.fn(() => true),
    externalReply: undefined as SessionManager['externalReply'],
  };
  const endpoint = await startExternalMcp(manager as unknown as SessionManager, path);
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const clients = tokens.map(() => new Client({ name: 'spec', version: '1' }));
  const data = (value: unknown) => {
    const text = (value as { content: { text: string }[] }).content[0]?.text;
    if (typeof text !== 'string') throw new Error('Missing MCP text result');
    return JSON.parse(text);
  };
  try {
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens[0]}`, Origin: 'https://untrusted.example' },
        })
      ).status,
    ).toBe(403);
    await Promise.all(
      clients.map((client, i) =>
        client.connect(
          new StreamableHTTPClientTransport(url, {
            requestInit: { headers: { Authorization: `Bearer ${tokens[i]}` } },
          }),
        ),
      ),
    );
    const [a, b] = clients;
    if (!a || !b) throw new Error('Missing test clients');
    expect((await a.listTools()).tools.map((t) => t.name)).toContain('get_messages');
    const list = data(await a.callTool({ name: 'list_sessions', arguments: {} }));
    expect(list.sessions[0].id).toBe(peer.id);
    const project_id = list.sessions[0].project_id;
    const args = {
      project_id,
      session_id: peer.id,
      message: 'hello',
      idempotency_key: 'retry-safe',
    };
    const [one, two] = await Promise.all(
      [a, b].map((client) => client.callTool({ name: 'send_message', arguments: args }).then(data)),
    );
    expect(one.conversation_id).not.toBe(two.conversation_id);
    expect(data(await a.callTool({ name: 'send_message', arguments: args })).message_id).toBe(
      one.message_id,
    );
    expect(
      (
        await b.callTool({
          name: 'get_messages',
          arguments: { project_id, conversation_id: one.conversation_id },
        })
      ).isError,
    ).toBe(true);
    await vi.waitFor(() => expect(manager.deliverExternalMessage).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    const envelope = manager.deliverExternalMessage.mock.calls[0] as unknown as [string, string];
    const address = /from="(external:[^"]+)"/.exec(envelope[1])?.[1];
    const reply = manager.externalReply;
    if (!address || !reply) throw new Error('Missing reply route');
    reply(peer, address, 'reply from the same session');
    const owner = address.includes(one.conversation_id) ? a : b;
    const sent = owner === a ? one : two;
    const messages = data(
      await owner.callTool({
        name: 'get_messages',
        arguments: { project_id, conversation_id: sent.conversation_id, cursor: 1 },
      }),
    );
    expect(messages.messages[0].text).toBe('reply from the same session');
    writeFileSync(path, '{}');
    expect(
      (await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${tokens[0]}` } }))
        .status,
    ).toBe(503);
    expect(() => reply(peer, address, 'after revocation')).toThrow('external_mcp_revoked');
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await endpoint.close();
    if (oldHome === undefined) Reflect.deleteProperty(process.env, 'ATEAM_HOME');
    else process.env.ATEAM_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
