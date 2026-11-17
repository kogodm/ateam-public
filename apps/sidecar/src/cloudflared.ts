/** Runs the named Cloudflare Tunnel set up by scripts/setup-public-mcp.sh for as long as Ateam runs. */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];

export type TunnelState = 'starting' | 'running' | 'error' | 'missing-cloudflared';
type Report = (state: TunnelState, error?: string) => void;

export function startCloudflared(home: string, report: Report): { stop: () => void } {
  const config = join(home, 'external-mcp', 'cloudflared.yml');
  const binary = CANDIDATES.find((p) => existsSync(p));
  if (!binary) {
    report('missing-cloudflared', 'Install cloudflared, then run scripts/setup-public-mcp.sh.');
    return { stop: () => {} };
  }
  if (!existsSync(config)) {
    report('error', 'Tunnel configuration missing. Run scripts/setup-public-mcp.sh.');
    return { stop: () => {} };
  }
  // The app can end the sidecar without close(); a tunnel left behind keeps
  // serving (and doubles up). Reap ours from last time, and never outlive this process.
  const pidFile = join(home, 'external-mcp', 'cloudflared.pid');
  reapStale(pidFile, config);
  let child: ChildProcess | undefined;
  const killChild = () => child?.kill('SIGTERM');
  process.once('exit', killChild);
  let stopped = false;
  let delay = 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    report('starting');
    let lastLine = '';
    const proc = spawn(binary, ['tunnel', '--no-autoupdate', '--config', config, 'run'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child = proc;
    if (proc.pid) writeFileSync(pidFile, String(proc.pid), { mode: 0o600 });
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        if (/Registered tunnel connection/.test(line)) {
          delay = 2000;
          report('running');
        } else if (/\bERR\b/.test(line)) lastLine = line.replace(/^\S+\s+ERR\s+/, '').slice(0, 200);
      }
    });
    proc.on('exit', (code) => {
      child = undefined;
      if (stopped) return;
      report('error', lastLine || `cloudflared exited (${code ?? 'signal'}); retrying`);
      timer = setTimeout(run, delay);
      delay = Math.min(delay * 2, 60_000);
    });
    proc.on('error', (e) => report('error', e.message));
  };
  run();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      process.off('exit', killChild);
      killChild();
      rmSync(pidFile, { force: true });
    },
  };
}

function reapStale(pidFile: string, config: string): void {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 1) return;
    // only a cloudflared running our config — pids get reused
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (command.includes('cloudflared') && command.includes(config)) process.kill(pid, 'SIGTERM');
  } catch {
    /* no file or no such process */
  }
}
