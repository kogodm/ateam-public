import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IS_WINDOWS, whichSync, whichViaSystem } from '../platform';

/**
 * Per-workspace CodeGraph MCP (https://github.com/colbymchenry/codegraph):
 * a tree-sitter code graph exposed to claude over MCP so the agent can do
 * fast code queries instead of brute file reads. Default on; ATEAM_CODEGRAPH=0
 * disables. Uses a global `codegraph` if installed, else `npx -y …`.
 */
export function codegraphEnabled(): boolean {
  return process.env.ATEAM_CODEGRAPH !== '0';
}

let resolved: { command: string; args: string[] } | undefined;
export function resolveCodegraph(): { command: string; args: string[] } {
  if (resolved) return resolved;
  const bin = whichSync('codegraph') ?? whichViaSystem('codegraph');
  if (bin) {
    resolved = { command: bin, args: ['serve', '--mcp'] };
    return resolved;
  }
  // Windows: prefer npx.cmd so `spawn` finds it without a shell.
  const npx = IS_WINDOWS ? 'npx.cmd' : 'npx';
  resolved = { command: npx, args: ['-y', '@colbymchenry/codegraph', 'serve', '--mcp'] };
  return resolved;
}

/** Write a per-session MCP config file and return its path (for --mcp-config). */
export function writeCodegraphMcpConfig(sessionId: string): string {
  const cg = resolveCodegraph();
  const cfg = {
    mcpServers: {
      codegraph: { type: 'stdio', command: cg.command, args: cg.args },
    },
  };
  const path = join(tmpdir(), `ateam-mcp-${sessionId}.json`);
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

const initialized = new Set<string>();

/** Best-effort, non-blocking `codegraph init` so the index exists. Never
 *  blocks agent spawn; serve auto-syncs anyway. */
export function ensureCodegraphInit(cwd: string): void {
  if (initialized.has(cwd) || existsSync(join(cwd, '.codegraph'))) {
    initialized.add(cwd);
    return;
  }
  initialized.add(cwd);
  const cg = resolveCodegraph();
  // non-interactive one-step init + index (bare `codegraph init` is
  // interactive by default and `serve --mcp` does NOT auto-index).
  const base = cg.args.slice(0, -2); // drop ['serve','--mcp']
  try {
    const child = spawn(cg.command, [...base, 'init', cwd, '--index'], {
      cwd,
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 120_000);
    t.unref();
    child.unref();
  } catch {
    /* best-effort */
  }
}
