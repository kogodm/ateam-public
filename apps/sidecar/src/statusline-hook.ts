/**
 * Claude Code status line command, injected through `--settings`. Claude hands
 * it a JSON document on stdin after every reply; one field of it,
 * `rate_limits`, is the subscription's "Current session / This week" usage and
 * is available nowhere else. This saves that field for the Status panel, then
 * runs the status line the person had configured themselves (project, local,
 * then user settings) with the same input, so their own status line still
 * draws exactly as before. Best-effort: it always exits 0.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { saveClaudeRateLimits } from '@ateam/core';

function configuredCommand(cwd: string): string | undefined {
  const files = [
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.json'),
  ];
  for (const file of files) {
    try {
      const sl = (JSON.parse(readFileSync(file, 'utf8')) as { statusLine?: { command?: string } })
        .statusLine;
      if (sl?.command) return sl.command;
    } catch {
      /* no such file, or not JSON */
    }
  }
  return undefined;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  input += d;
});
process.stdin.on('end', () => {
  let cwd = process.cwd();
  try {
    const doc = JSON.parse(input) as {
      rate_limits?: Parameters<typeof saveClaudeRateLimits>[0];
      workspace?: { current_dir?: string };
      cwd?: string;
    };
    saveClaudeRateLimits(doc.rate_limits);
    cwd = doc.workspace?.current_dir ?? doc.cwd ?? cwd;
  } catch {
    /* not JSON — still hand it on */
  }
  const command = configuredCommand(cwd);
  if (command) {
    const r = spawnSync(command, { shell: true, input, encoding: 'utf8', cwd, timeout: 5000 });
    if (r.stdout) process.stdout.write(r.stdout);
  }
  process.exit(0);
});
