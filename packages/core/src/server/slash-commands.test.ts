import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionNode } from '@ateam/contract';
import type { LlmSynthesizer } from '@ateam/knowledge';
import { createInprocPair } from '@ateam/transport';
import { expect, it, vi } from 'vitest';
import { SessionManager } from '../session/manager';
import { RpcClient } from './rpc-client';
import { createServer } from './rpc-server';

it('routes slash suggestions by session provider instead of leaking Claude commands into Codex', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ateam-slash-rpc-'));
  vi.stubEnv('ATEAM_HOME', root);
  vi.stubEnv('CODEX_HOME', join(root, 'codex'));
  const directory = join(root, '.claude', 'commands');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'claude-project-only.md'), 'Fixture command');
  const sessions = new SessionManager();
  vi.spyOn(sessions, 'get').mockImplementation(
    (sessionId) =>
      ({
        providerId: sessionId === 'codex' ? 'codex' : 'claude',
      }) as SessionNode,
  );
  vi.spyOn(sessions, 'cwdOf').mockReturnValue(root);
  const synth: LlmSynthesizer = {
    async reflect() {
      return [];
    },
    async learnFromRepo() {
      return [];
    },
    async distillSkill(domain) {
      return { name: domain, domain, description: '', body: '', tags: [] };
    },
  };
  const server = createServer({ sessions, synth, storeRoot: root });
  const pair = createInprocPair();
  server.attach(pair.server);
  const client = new RpcClient(pair.client);
  try {
    const codex = await client.request<{ commands: { name: string }[] }>('claude.commands', {
      sessionId: 'codex',
    });
    expect(codex.commands.some((command) => command.name === 'permissions')).toBe(true);
    expect(codex.commands.some((command) => command.name === 'cost')).toBe(false);
    expect(codex.commands.some((command) => command.name === 'claude-project-only')).toBe(false);
    const claude = await client.request<{ commands: { name: string }[] }>('claude.commands', {
      sessionId: 'claude',
    });
    expect(claude.commands.some((command) => command.name === 'claude-project-only')).toBe(true);
    expect(claude.commands.some((command) => command.name === 'cost')).toBe(true);
  } finally {
    pair.client.close();
    server.shutdown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
