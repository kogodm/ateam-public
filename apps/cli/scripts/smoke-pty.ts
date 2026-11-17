/**
 * M0 risk validation: spawn the REAL `claude` via node-pty and confirm bytes
 * flow end-to-end through SessionManager -> RpcServer -> @ateam/contract ->
 * RpcClient. No assertions about claude itself; we only prove the pipeline.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectTree, SessionNode } from '@ateam/contract';
import { RpcClient, SessionManager, createServer } from '@ateam/core';
import { createInprocPair } from '@ateam/transport';

async function main(): Promise<void> {
  const ws = mkdtempSync(join(tmpdir(), 'ateam-smoke-'));
  const sessions = new SessionManager();
  const server = createServer({ sessions });
  const { client, server: sp } = createInprocPair();
  server.attach(sp);
  const rpc = new RpcClient(client);

  let bytes = 0;
  let firstSnippet = '';
  rpc.on<{ sessionId: string; chunk: string }>('session.output', (d) => {
    bytes += d.chunk.length;
    if (!firstSnippet) firstSnippet = d.chunk.slice(0, 80).replace(/\s+/g, ' ');
  });

  const spawn = await rpc.request<{ session: SessionNode }>('session.spawn', {
    projectName: 'smoke',
    agentName: 'coder-1',
    role: 'coder',
    workspace: { id: 'ws1', name: 'smoke', root: ws },
  });
  console.log(`spawned session ${spawn.session.sessionId} (cwd=${ws}, state=${spawn.session.state})`);

  await new Promise((r) => setTimeout(r, 6000));

  const list = await rpc.request<{ projects: ProjectTree[] }>('session.list');
  const tr = await rpc.request<{ turns: unknown[] }>('session.transcript', {
    sessionId: spawn.session.sessionId,
  });

  console.log(`PTY bytes received: ${bytes}`);
  console.log(`first output: "${firstSnippet}"`);
  console.log(`session.list projects: ${list.projects.length}, sessions: ${list.projects[0]?.sessions.length}`);
  console.log(`session.transcript turns: ${tr.turns.length}`);

  await rpc.request('session.kill', { sessionId: spawn.session.sessionId });
  server.shutdown();

  if (bytes === 0) {
    console.error('FAIL: no PTY output — claude did not start or pipeline broken');
    process.exit(1);
  }
  console.log('OK: end-to-end PTY pipeline works');
  process.exit(0);
}

void main();
