import { defineConfig } from 'tsup';

// Self-contained sidecar: inline the workspace packages + all pure-JS deps
// into one CJS file so a packaged app needs no node_modules. node-pty is a
// native addon (.node) — keep it external and ship it as a Tauri resource
// next to the bundle.
export default defineConfig({
  // index.cjs = the RPC sidecar; mcp-tasks.cjs = the per-session `ateam-tasks`
  // MCP server (--mcp-config); session-hook.cjs = the SessionStart reporter
  // that follows claude's session-id rotation on /clear (--settings hook).
  entry: [
    'src/index.ts',
    'src/mcp-tasks.ts',
    'src/mcp-chat.ts',
    'src/mcp-peers.ts',
    'src/mcp-browser.ts',
    'src/mcp-desktop.ts',
    'src/session-hook.ts',
    'src/statusline-hook.ts',
  ],
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  // bundle everything EXCEPT node-pty (greedy /.*/ would also pull node-pty
  // in and esbuild then chokes on its internal `../build/*/pty.node`)
  noExternal: [/^(?!node-pty$).*/],
  external: ['node-pty'],
  // no shebang banner: the Rust shell always spawns this via `node`, and a
  // tsup banner lands on line 2 (after esbuild's CJS prologue) which Node
  // does NOT strip → "Invalid or unexpected token".
});
