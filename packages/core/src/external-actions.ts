import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { ExternalExec, ExternalExecLink } from './external-exec';
import type { ProjectTools } from './session/project-tools';

/**
 * run_command / git_commit / git_push for external clients, in a project where
 * the user granted the matching capability once (request_project_access). The
 * grant removes the per-call prompt, not this floor: no sudo, no force push,
 * no deleting the disk or home, and no commit that would include a sensitive file.
 */

const git = promisify(execFile);

const REFUSED: [RegExp, string][] = [
  [/(^|[;&|`(]\s*)sudo\b/, 'sudo is not allowed'],
  [/\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/, 'force push is not allowed'],
  [/\brm\s+(-\w*\s+)*-\w*[rR]\w*\s+(-\w+\s+)*(\/|~|\$HOME)(\s|$|\/\*)/, 'deleting the disk or home folder is not allowed'],
  [/\bgit\s+(reset\s+--hard|clean\s+-\w*f)\b.*\b(origin|HEAD~\d{2,})/, 'destructive history rewrite is not allowed'],
  [/\b(mkfs|diskutil\s+erase|shutdown|reboot)\b/, 'system commands are not allowed'],
];

export function refusedCommand(command: string): string | undefined {
  return REFUSED.find(([re]) => re.test(command))?.[1];
}

const cleanRel = (p: string): string => {
  if (!p || p.includes('\0') || isAbsolute(p) || p.split(/[\\/]/).includes('..'))
    throw new Error(`invalid path: ${p}`);
  return p.replace(/^\.\//, '');
};

export async function runCommand(
  exec: ExternalExec,
  ctx: { clientId: string; root: string; link?: ExternalExecLink },
  command: string,
  timeoutS = 120,
) {
  const why = refusedCommand(command);
  if (why) throw new Error(`refused: ${why}`);
  return exec.start({
    clientId: ctx.clientId,
    root: ctx.root,
    tool: 'run_command',
    argv: [command],
    shell: true,
    timeoutMs: Math.min(Math.max(timeoutS, 1), 600) * 1000,
    link: ctx.link,
  });
}

export async function gitCommit(
  exec: ExternalExec,
  files: ProjectTools,
  ctx: { clientId: string; root: string; projectId: string; link?: ExternalExecLink },
  message: string,
  paths?: string[],
) {
  if (!message.trim() || message.length > 5000 || message.includes('\0'))
    throw new Error('commit message must be 1–5000 characters');
  const targets = paths?.length ? paths.map(cleanRel) : ['.'];
  const opts = { cwd: ctx.root, timeout: 30_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  const dry = await git('git', ['add', '--dry-run', '-A', '--', ...targets], opts);
  const adding = dry.stdout
    .split('\n')
    .map((l) => /^(?:add|remove) '(.*)'$/.exec(l)?.[1])
    .filter((p): p is string => !!p);
  const staged = (await git('git', ['diff', '--cached', '--name-only', '-z'], opts)).stdout
    .split('\0')
    .filter(Boolean);
  const blocked = [...new Set([...adding, ...staged])].filter((p) => files.restricted(ctx.projectId, p));
  if (blocked.length)
    throw new Error(
      `refused: the commit would include restricted files (${blocked.slice(0, 5).join(', ')}). Unstage them or add them to .gitignore.`,
    );
  if (!adding.length && !staged.length) throw new Error('nothing to commit');
  await git('git', ['add', '-A', '--', ...targets], opts);
  const run = await exec.start({
    clientId: ctx.clientId,
    root: ctx.root,
    tool: 'git_commit',
    argv: ['git', 'commit', '-m', message],
    timeoutMs: 120_000,
    link: ctx.link,
  });
  if (run.status === 'exited' && run.exit_code === 0) {
    const [commit = '', ...subject] = (await git('git', ['log', '-1', '--format=%H %s'], opts)).stdout
      .trim()
      .split(' ');
    return { ...run, commit, subject: subject.join(' '), files: [...new Set([...adding, ...staged])].slice(0, 100) };
  }
  return run;
}

export async function gitPush(
  exec: ExternalExec,
  ctx: { clientId: string; root: string; link?: ExternalExecLink },
  remote?: string,
  branch?: string,
) {
  const name = /^[\w][\w./-]{0,199}$/;
  if ((remote && !name.test(remote)) || (branch && !name.test(branch)))
    throw new Error('remote and branch must be plain names (no flags)');
  if (branch && !remote) throw new Error('branch needs remote');
  return exec.start({
    clientId: ctx.clientId,
    root: ctx.root,
    tool: 'git_push',
    argv: ['git', 'push', ...(remote ? [remote] : []), ...(branch ? [branch] : [])],
    timeoutMs: 180_000,
    link: ctx.link,
  });
}
