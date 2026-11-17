import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalRunDTO } from '@ateam/contract';
import type { DistilledSkill, LearnedItem, LlmSynthesizer, ReflectionItem } from '@ateam/knowledge';
import { createInprocPair } from '@ateam/transport';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionManager } from '../session/manager';
import { RpcClient } from './rpc-client';
import { createServer } from './rpc-server';

class NoSynth implements LlmSynthesizer {
  reflect(): Promise<ReflectionItem[]> {
    return Promise.resolve([]);
  }
  learnFromRepo(): Promise<LearnedItem[]> {
    return Promise.resolve([]);
  }
  distillSkill(domain: string): Promise<DistilledSkill> {
    return Promise.resolve({ name: domain, domain, description: '', body: '', tags: [] });
  }
}

describe('linked external command RPC and events', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-external-runs-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('broadcasts standalone runs to both clients and serves their history separately from turns', async () => {
    const sessions = new SessionManager();
    const sample: ExternalRunDTO = {
      executionId: 'exec-1',
      sessionId: 'runtime-1',
      tool: 'run_command',
      command: 'pnpm test',
      status: 'exited',
      exitCode: 0,
      startedAt: '2026-10-15T12:00:00.000Z',
      endedAt: '2026-10-15T12:00:01.000Z',
      output: 'passed',
      truncated: false,
    };
    sessions.externalRuns = (sessionId) => (sessionId === 'runtime-1' ? [sample] : []);
    const server = createServer({ sessions, synth: new NoSynth(), storeRoot: home });
    const connect = () => {
      const { client, server: serverPort } = createInprocPair();
      server.attach(serverPort);
      return new RpcClient(client);
    };
    const desktop = connect();
    const phone = connect();
    const desktopTurns: unknown[] = [];
    const phoneTurns: unknown[] = [];
    desktop.on('session.turn', (event) => desktopTurns.push(event));
    phone.on('session.turn', (event) => phoneTurns.push(event));
    const nextRun = (client: RpcClient) =>
      new Promise<{ sessionId: string; run: ExternalRunDTO }>((resolve) => {
        client.on('session.externalRun', resolve);
      });
    const desktopRun = nextRun(desktop);
    const phoneRun = nextRun(phone);

    sessions.emit('externalRun', { sessionId: 'runtime-1', run: sample });

    await expect(desktopRun).resolves.toEqual({ sessionId: 'runtime-1', run: sample });
    await expect(phoneRun).resolves.toEqual({ sessionId: 'runtime-1', run: sample });
    expect(desktopTurns).toEqual([]);
    expect(phoneTurns).toEqual([]);
    await expect(desktop.request('session.externalRuns', { sessionId: 'runtime-1' })).resolves.toEqual({
      runs: [sample],
    });
    await expect(desktop.request('session.externalRuns', { sessionId: 'other-session' })).resolves.toEqual({
      runs: [],
    });

    server.shutdown();
    sessions.shutdown();
  });
});
