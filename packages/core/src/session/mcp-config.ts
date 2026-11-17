import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromeBinary } from '../browser/cdp';
import { codegraphEnabled, resolveCodegraph } from './codegraph';

/**
 * The MCP servers ATeam hands every spawned session over `--mcp-config`:
 *   • ateam-tasks — the task list / reminders bridge (always on), scoped to
 *     this session's project so an agent's `add_task` lands in the right list.
 *   • ateam-peers — cross-provider teammate messages (always on).
 *   • codegraph  — per-workspace code graph (when enabled).
 *
 * One combined config file per session so both coexist. Previously only
 * codegraph was written, and only when it was enabled — meaning a
 * codegraph-off session had no ATeam MCP at all.
 */
interface McpStdioServer {
  type: 'stdio';
  command: string;
  args: string[];
}

/** Directory of the running sidecar bundle (index.cjs). `mcp-tasks.cjs` is
 *  emitted next to it by tsup and copied beside it in the packaged app
 *  (Contents/Resources/sidecar). In the single-file CJS bundle `__dirname` is
 *  that dir; fall back to the launched entry's dir if it's ever undefined. */
function sidecarDir(): string {
  if (typeof __dirname === 'string' && __dirname) return __dirname;
  const entry = process.argv[1];
  return entry ? dirname(entry) : process.cwd();
}

export function peerMcpServer(sessionId: string): McpStdioServer {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [join(sidecarDir(), 'mcp-peers.cjs'), '--session', sessionId],
  };
}

export function taskMcpServer(sessionId: string, cwd: string): McpStdioServer {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [join(sidecarDir(), 'mcp-tasks.cjs'), '--cwd', cwd, '--session', sessionId],
  };
}

export function sessionMcpServers(
  sessionId: string,
  cwd: string,
  /** when this session is the backing worker for a chat, mount `ateam-chat`
   *  too so the teammate can speak into that chat (see chat mode) */
  chat?: { chatId: string; humanId: string },
): Record<string, McpStdioServer> {
  const servers: Record<string, McpStdioServer> = {
    'ateam-peers': peerMcpServer(sessionId),
    'ateam-tasks': taskMcpServer(sessionId, cwd),
  };
  if (chat) {
    servers['ateam-chat'] = {
      type: 'stdio',
      command: process.execPath,
      args: [
        join(sidecarDir(), 'mcp-chat.cjs'),
        '--chat',
        chat.chatId,
        '--human',
        chat.humanId,
        '--session',
        sessionId,
      ],
    };
  }
  // the session's own browser, shown live in the stream — only where a Chrome exists
  if (chromeBinary()) {
    servers['ateam-browser'] = {
      type: 'stdio',
      command: process.execPath,
      args: [join(sidecarDir(), 'mcp-browser.cjs'), '--session', sessionId],
    };
  }
  if (codegraphEnabled()) {
    const cg = resolveCodegraph();
    servers.codegraph = { type: 'stdio', command: cg.command, args: cg.args };
  }
  return servers;
}

export function writeSessionMcpConfig(
  sessionId: string,
  cwd: string,
  chat?: { chatId: string; humanId: string },
): string {
  const servers = sessionMcpServers(sessionId, cwd, chat);
  const path = join(tmpdir(), `ateam-mcp-${sessionId}.json`);
  writeFileSync(path, JSON.stringify({ mcpServers: servers }));
  return path;
}

/**
 * `--settings` JSON (merged on top of the user's own settings — never replaces
 * them) that registers a SessionStart hook. The hook runs `session-hook.cjs`,
 * which reports claude's CURRENT session id back to the sidecar so ATeam can
 * follow the id rotation `/clear` performs. Runs for every source
 * (startup / resume / clear / compact); the sidecar no-ops when the id is
 * unchanged. The same script is the `PreCompact` hook: Claude Code's own
 * compaction is told to keep what the session learned (session-hook.ts).
 */
export function sessionHookSettings(): string {
  const script = join(sidecarDir(), 'session-hook.cjs');
  // claude runs the hook command through a shell → quote both paths for spaces.
  const command = `"${process.execPath}" "${script}"`;
  // the status line wrapper saves the subscription's usage windows, then runs
  // the person's own status line (see statusline-hook.ts)
  const statusLine = `"${process.execPath}" "${join(sidecarDir(), 'statusline-hook.cjs')}"`;
  return JSON.stringify({
    statusLine: { type: 'command', command: statusLine },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command }] }],
      PreCompact: [{ hooks: [{ type: 'command', command }] }],
    },
  });
}
