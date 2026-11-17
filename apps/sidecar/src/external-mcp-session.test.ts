import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer as createNetServer, type Server } from 'node:net';
import { join } from 'node:path';
import type { ExternalRunDTO } from '@ateam/contract';
import { ExternalAccess, RpcClient, SessionManager, createServer } from '@ateam/core';
import { createInprocPair, type Port } from '@ateam/transport';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it, vi } from 'vitest';
import { startExternalMcp } from './external-mcp';

const closeReservation = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

async function reservePorts() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const main = createNetServer();
    const publicMcp = createNetServer();
    try {
      await new Promise<void>((resolve, reject) => {
        main.once('error', reject);
        main.listen(0, '127.0.0.1', resolve);
      });
      const port = (main.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) => {
        publicMcp.once('error', reject);
        publicMcp.listen(port + 2, '127.0.0.1', resolve);
      });
      return { port, release: () => Promise.all([main, publicMcp].map(closeReservation)) };
    } catch (error) {
      await Promise.all([main, publicMcp].map(closeReservation));
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === 4) throw error;
    }
  }
  throw new Error('Unable to reserve MCP ports');
}

function toolData<T>(reply: unknown): T {
  const result = reply as { isError?: boolean; content: { type: string; text?: string }[] };
  expect(result.isError).not.toBe(true);
  const text = result.content.find((block) => block.type === 'text')?.text;
  if (!text) throw new Error('Missing MCP tool result');
  return JSON.parse(text) as T;
}

it('delivers an authorized HTTP MCP execution to two session RPC clients without transcript events', async () => {
  const home = realpathSync(mkdtempSync('/tmp/ATeam_HOME-linked-e2e-'));
  const oldHome = process.env.ATEAM_HOME;
  process.env.ATEAM_HOME = home;
  const ports: Port[] = [];
  const client = new Client({ name: 'session-linked-e2e', version: '1' });
  let sessions: SessionManager | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let service: Awaited<ReturnType<typeof startExternalMcp>> | undefined;
  let reserved: Awaited<ReturnType<typeof reservePorts>> | undefined;
  try {
    const project = join(home, 'project');
    mkdirSync(project);
    sessions = new SessionManager();
    const peerSpy = vi.spyOn(sessions, 'listPeerSessions').mockReturnValue(
      ['A', 'B'].map((suffix) => ({
        id: `runtime${suffix}`,
        stable_id: `stable${suffix}`,
        name: `Fixture ${suffix}`,
        provider: 'codex',
        projectDir: project,
        state: 'idle' as const,
        model: '',
      })),
    );
    const inputSpy = vi.spyOn(sessions, 'input');
    server = createServer({
      sessions,
      storeRoot: home,
      synth: {
        async reflect() { return []; },
        async learnFromRepo() { return []; },
        async distillSkill(domain) {
          return { name: domain, domain, description: '', body: '', tags: [] };
        },
      },
    });
    const observers = [0, 1].map(() => {
      const pair = createInprocPair();
      ports.push(pair.client, pair.server);
      server!.attach(pair.server);
      const rpc = new RpcClient(pair.client);
      const runs: { sessionId: string; run: ExternalRunDTO }[] = [];
      const turns: unknown[] = [];
      const output: unknown[] = [];
      rpc.on<typeof runs[number]>('session.externalRun', (data) => runs.push(data));
      rpc.on('session.turn', (data) => turns.push(data));
      rpc.on('session.output', (data) => output.push(data));
      return { rpc, runs, turns, output };
    });

    reserved = await reservePorts();
    const access = new ExternalAccess(home, () => [project]);
    access.port = reserved.port;
    access.touch('fixture-client', 'E2E fixture');
    access.decide('fixture-client', true, [project]);
    const request = access.requestAccess('fixture-client', project, ['execute'], 'E2E command');
    access.decideRequest(request.request_id as string, true);
    const token = access.approved()[0]?.token;
    if (!token) throw new Error('Missing approved fixture token');
    await reserved.release();
    reserved = undefined;
    // startExternalMcp constructs the real ExternalConversations using these grants.
    service = await startExternalMcp(sessions, undefined, access);
    expect(access.error).toBeFalsy();
    await client.connect(new StreamableHTTPClientTransport(new URL(access.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    const projects = toolData<{ projects: { project_id: string }[] }>(
      await client.callTool({ name: 'list_projects', arguments: {} }),
    );
    const projectId = projects.projects[0]?.project_id;
    if (!projectId) throw new Error('Missing authorized fixture project');
    const reply = await client.callTool({
      name: 'run_command',
      arguments: {
        project_id: projectId,
        session_id: 'stableA',
        command: "printf 'password=FixtureSecret123'",
      },
    });
    expect(JSON.stringify(reply)).not.toContain('FixtureSecret123');
    const result = toolData<{ execution_id: string; status: string; exit_code: number; output: string }>(reply);
    expect(result).toMatchObject({ status: 'exited', exit_code: 0, output: 'password=[redacted]' });
    expect(result.execution_id).toEqual(expect.any(String));
    await vi.waitFor(() => {
      for (const observer of observers) expect(observer.runs.at(-1)?.run.status).toBe('exited');
    });
    for (const observer of observers) {
      expect(observer.runs[0]?.run.status).toBe('running');
      expect(observer.runs.at(-1)?.run).toMatchObject({
        executionId: result.execution_id, status: 'exited', exitCode: 0, output: result.output,
      });
      expect(observer.runs.every(({ sessionId, run }) =>
        sessionId === 'runtimeA' && run.sessionId === 'runtimeA' && run.executionId === result.execution_id,
      )).toBe(true);
      expect(JSON.stringify(observer.runs)).not.toContain('FixtureSecret123');
      const history = await observer.rpc.request<{ runs: ExternalRunDTO[] }>(
        'session.externalRuns', { sessionId: 'runtimeA' },
      );
      expect(history).toEqual({ runs: [observer.runs.at(-1)!.run] });
      expect(history.runs[0]?.output).toBe('password=[redacted]');
      expect(JSON.stringify(history)).not.toContain('FixtureSecret123');
      await expect(observer.rpc.request('session.externalRuns', { sessionId: 'runtimeB' }))
        .resolves.toEqual({ runs: [] });
      expect(observer.turns).toEqual([]);
      expect(observer.output).toEqual([]);
    }
    expect(observers[1]?.runs).toEqual(observers[0]?.runs);
    expect(inputSpy).not.toHaveBeenCalled();
    peerSpy.mockRestore();
    inputSpy.mockRestore();
  } finally {
    try {
      await client.close();
    } finally {
      try {
        await service?.close();
      } finally {
        try {
          await reserved?.release();
          for (const port of ports) port.close();
          if (server) server.shutdown();
          else sessions?.shutdown();
        } finally {
          if (oldHome === undefined) delete process.env.ATEAM_HOME;
          else process.env.ATEAM_HOME = oldHome;
          rmSync(home, { recursive: true, force: true });
        }
      }
    }
  }
}, 15_000);
