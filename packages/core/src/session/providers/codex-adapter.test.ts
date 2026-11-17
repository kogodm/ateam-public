import { readFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { peerMcpServer, taskMcpServer, writeSessionMcpConfig } from '../mcp-config';
import { codexAdapter } from './codex-adapter';

vi.mock('../codegraph', () => ({
  codegraphEnabled: () => process.env.ATEAM_CODEGRAPH !== '0',
  resolveCodegraph: () => ({ command: '/test/codegraph', args: ['serve', '--mcp'] }),
}));
afterEach(() => vi.unstubAllEnvs());
// the session browser is mounted wherever a Chrome exists — pin it so the list does not depend on the machine
beforeEach(() => vi.stubEnv('ATEAM_CHROME', '/test/chrome'));

describe('session MCP mounting', () => {
  it.each([undefined, 'old-thread'])(
    'uses the complete generated MCP config (%s)',
    (resumeSessionId) => {
      const cwd = '/tmp/workspace with spaces';
      const path = writeSessionMcpConfig('shared-mount-spec', cwd, {
        chatId: 'chat',
        humanId: 'human',
      });
      try {
        const servers = JSON.parse(readFileSync(path, 'utf8')).mcpServers;
        const args = codexAdapter.buildArgs({
          sessionId: 'provider-thread',
          ateamSessionId: 'shared-mount-spec',
          sessionName: '',
          cwd,
          appendSystemPrompt: '',
          mcpConfigPath: path,
          resumeSessionId,
        });
        expect(Object.keys(servers).sort()).toEqual([
          'ateam-browser',
          'ateam-chat',
          'ateam-peers',
          'ateam-tasks',
          'codegraph',
        ]);
        for (const [name, server] of Object.entries(servers) as [
          string,
          { command: string; args: string[] },
        ][]) {
          const key = name.replaceAll('-', '_');
          for (const [field, value] of Object.entries({
            command: server.command,
            args: server.args,
            cwd,
          })) {
            const entry = `mcp_servers.${key}.${field}=${JSON.stringify(value)}`;
            expect(args).toContain(entry);
            expect(args[args.indexOf(entry) - 1]).toBe('-c');
          }
        }
      } finally {
        rmSync(path);
      }
    },
  );
  it('keeps task and peer tools when codegraph is disabled', () => {
    vi.stubEnv('ATEAM_CODEGRAPH', '0');
    const path = writeSessionMcpConfig('disabled-graph-spec', '/tmp');
    try {
      const args = codexAdapter.buildArgs({
        sessionId: 'row',
        sessionName: '',
        cwd: '/tmp',
        appendSystemPrompt: '',
        mcpConfigPath: path,
      });
      expect(args.some((value) => value.startsWith('mcp_servers.codegraph.'))).toBe(false);
      expect(args.some((value) => value.startsWith('mcp_servers.ateam_tasks.'))).toBe(true);
      expect(args.some((value) => value.startsWith('mcp_servers.ateam_peers.'))).toBe(true);
    } finally {
      rmSync(path);
    }
  });
  it.each([undefined, 'old-thread'])(
    'mounts project-scoped tasks for fresh and resumed Codex (%s)',
    (resumeSessionId) => {
      const sessionId = 'ateam-row';
      const cwd = '/tmp/project with spaces/quote"slash\\';
      const server = taskMcpServer(sessionId, cwd);
      const args = codexAdapter.buildArgs({
        sessionId: 'provider-thread',
        ateamSessionId: sessionId,
        sessionName: '',
        cwd,
        appendSystemPrompt: '',
        mcpConfigPath: '',
        resumeSessionId,
      });
      for (const [key, value] of Object.entries({ command: server.command, args: server.args })) {
        const entry = `mcp_servers.ateam_tasks.${key}=${JSON.stringify(value)}`;
        expect(args).toContain(entry);
        expect(args[args.indexOf(entry) - 1]).toBe('-c');
        expect(JSON.parse(entry.slice(entry.indexOf('=') + 1))).toEqual(value);
      }
      expect(server.args).toEqual([
        expect.stringMatching(/mcp-tasks\.cjs$/),
        '--cwd',
        cwd,
        '--session',
        sessionId,
      ]);
    },
  );
  it.each([undefined, 'old-thread'])(
    'mounts peers for fresh and resumed Codex (%s)',
    (resumeSessionId) => {
      const sessionId = 'quote"slash\\newline\n';
      const server = peerMcpServer(sessionId);
      const args = codexAdapter.buildArgs({
        sessionId,
        sessionName: 'name',
        cwd: '/tmp',
        appendSystemPrompt: '',
        mcpConfigPath: '',
        resumeSessionId,
      });
      for (const [key, value] of Object.entries({ command: server.command, args: server.args })) {
        const entry = `mcp_servers.ateam_peers.${key}=${JSON.stringify(value)}`;
        expect(args).toContain(entry);
        expect(args[args.indexOf(entry) - 1]).toBe('-c');
        expect(JSON.parse(entry.slice(entry.indexOf('=') + 1))).toEqual(value);
      }
      expect(server.args).toEqual([
        expect.stringMatching(/mcp-peers\.cjs$/),
        '--session',
        sessionId,
      ]);
      expect(args).toContain(
        `mcp_servers.ateam_tasks.args=${JSON.stringify(taskMcpServer(sessionId, '/tmp').args)}`,
      );
    },
  );
  it('addresses the Ateam session, not the provider conversation id', () => {
    const args = codexAdapter.buildArgs({
      sessionId: 'provider-thread',
      ateamSessionId: 'ateam-row',
      sessionName: '',
      cwd: '/tmp',
      appendSystemPrompt: '',
      mcpConfigPath: '',
    });
    expect(args).toContain(
      `mcp_servers.ateam_peers.args=${JSON.stringify(peerMcpServer('ateam-row').args)}`,
    );
  });
  it('mounts the same server in the Claude config', () => {
    const path = writeSessionMcpConfig('peer-mount-spec', '/tmp');
    try {
      expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers['ateam-peers']).toEqual(
        peerMcpServer('peer-mount-spec'),
      );
      expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers['ateam-tasks']).toEqual(
        taskMcpServer('peer-mount-spec', '/tmp'),
      );
    } finally {
      rmSync(path);
    }
  });
});
