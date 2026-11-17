#!/usr/bin/env node
/**
 * Ateam sidecar — the same Node core the TUI embeds, hosted over a loopback
 * WebSocket so the Tauri desktop shell can drive it through @ateam/contract
 * (zero backend rewrite). The Rust shell spawns this, reads ONE JSON line
 * from stdout to discover {port,token}, and connects the webview to it. A
 * handshake file is also written as a fallback. Lifetime is tied to the
 * parent: closing stdin (shell exit) shuts the core down cleanly.
 */
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ExternalAccess,
  SessionManager,
  ateamHome,
  closeChrome,
  createServer,
  inheritedClaudeMarkers,
} from '@ateam/core';
import { startWsServer } from '@ateam/transport';
import { startExternalMcp } from './external-mcp';
import { autoRegisterCursorDesktop } from './cursor-desktop-registration';

/** When the macOS desktop app is launched from /Applications (not from a
 *  shell), launchd gives the process a sparse PATH (/usr/bin:/bin:…) — no
 *  /opt/homebrew/bin or /usr/local/bin, so codegraph / npx / git can'\''t be
 *  found and the MCP silently fails. Front-load the common bin dirs so
 *  spawned children inherit a useful PATH.
 *
 *  On Windows the launchctl problem doesn't exist; PATH already covers
 *  Program Files / npm-global / etc. when the .exe is launched by the
 *  Tauri shell. On Linux desktop launchers behave similarly.  */
function augmentPath(): void {
  if (process.platform !== 'darwin') return;
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME ?? ''}/.local/bin`];
  const cur = (process.env.PATH ?? '').split(':').filter(Boolean);
  const missing = extras.filter((p) => p && !cur.includes(p));
  if (missing.length) process.env.PATH = [...missing, ...cur].join(':');
}

/** Say so, once, if this process was started from inside a claude session.
 *  Nothing downstream will complain: the markers are stripped before any PTY
 *  sees them (claude-env.ts), and the failure they used to cause — every
 *  session silently not saving its transcript — left no trace anywhere. A
 *  line on stderr is the only way this ever becomes visible in a log. */
function warnIfLaunchedUnderClaude(): void {
  const carried = inheritedClaudeMarkers();
  if (carried.length === 0) return;
  process.stderr.write(
    `[ateam] started from inside a claude session (${carried.join(', ')}) — stripped before spawning sessions; launch the app with a clean environment if you can (scripts/restart-app.sh does).\n`,
  );
}

async function main(): Promise<void> {
  augmentPath();
  warnIfLaunchedUnderClaude();
  const sessions = new SessionManager();
  const access = new ExternalAccess(ateamHome(), () =>
    sessions
      .listPeerSessions()
      .filter((s) => s.state !== 'exited')
      .map((s) => s.projectDir),
  );
  if (ateamHome().endsWith('.ateam-debug')) access.port = 8766;
  const bundleDir = typeof __dirname === 'string' ? __dirname : dirname(process.argv[1] ?? '');
  const connectorScript = join(bundleDir, 'mcp-desktop.cjs');
  const registerExternal = (client: 'claude-desktop' | 'chatgpt' | 'cursor-desktop') => {
    if (client === 'cursor-desktop')
      return access.registerCursorDesktop(
        join(homedir(), '.cursor', 'mcp.json'),
        process.execPath,
        connectorScript,
      );
    if (client === 'chatgpt')
      return access.registerChatgpt(homedir(), process.execPath, connectorScript);
    if (process.platform !== 'darwin')
      throw new Error('Automatic Claude Desktop registration currently requires macOS.');
    return access.registerClaude(
      join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      process.execPath,
      connectorScript,
    );
  };
  let externalMcp: Awaited<ReturnType<typeof startExternalMcp>> | undefined;
  const server = createServer({
    sessions,
    externalAccess: access,
    registerExternal,
    relayMcp: (stream) => (externalMcp ? externalMcp.acceptRelay(stream) : stream.destroy()),
  });
  const handle = await startWsServer((port) => server.attach(port));
  try {
    externalMcp = await startExternalMcp(sessions, undefined, access);
    {
      const file = join(ateamHome(), 'external-mcp', 'endpoint.json');
      writeFileSync(`${file}.tmp`, JSON.stringify({ url: access.endpoint }), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      for (const [client, app] of [
        ['claude-desktop', 'Claude'],
        ['chatgpt', 'ChatGPT'],
      ] as const) {
        if (
          process.platform === 'darwin' &&
          existsSync(`/Applications/${app}.app`) &&
          existsSync(connectorScript)
        ) {
          try {
            registerExternal(client);
          } catch (error) {
            access.error = error instanceof Error ? error.message : 'Client registration failed.';
          }
        }
      }
      if (process.platform === 'darwin') {
        try {
          autoRegisterCursorDesktop(
            homedir(),
            connectorScript,
            (configPath) =>
              access.registerCursorDesktop(configPath, process.execPath, connectorScript),
            existsSync,
          );
        } catch (error) {
          access.error =
            error instanceof Error ? error.message : 'Cursor Desktop registration failed.';
        }
      }
    }
  } catch {
    access.error = 'External MCP could not start. Check configuration and port 8765.';
    process.stderr.write(
      '[external-mcp] disabled: check private config, project roots and port availability\n',
    );
  }

  // FIRST stdout line, machine-readable, nothing printed before it.
  process.stdout.write(
    `${JSON.stringify({ port: handle.port, token: handle.token, pid: process.pid })}\n`,
  );

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await externalMcp?.close();
    server.shutdown();
    closeChrome();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  // tie lifetime to the parent shell: when it exits, our stdin ends
  process.stdin.resume();
  process.stdin.on('end', () => void stop());
  process.stdin.on('close', () => void stop());
}

main().catch((e) => {
  process.stderr.write(`sidecar fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
