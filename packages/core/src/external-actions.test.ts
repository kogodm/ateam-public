import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExternalAccess } from './external-access';
import { gitCommit, gitPush, refusedCommand, runCommand } from './external-actions';
import { ExternalExec } from './external-exec';
import { resolveProjectPath } from './external-requests';
import { ProjectTools } from './session/project-tools';

let home: string;
let repo: string;
let bare: string;
const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env }).toString();

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-actions-home-')));
  mkdirSync(join(home, 'external-mcp'), { recursive: true });
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-actions-repo-')));
  bare = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-actions-bare-')));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) process.env[k] = env[k];
});
afterAll(() => {
  for (const d of [home, repo, bare]) rmSync(d, { recursive: true, force: true });
});

describe('project paths a client may request', () => {
  it('refuses home, its ancestors, credentials and Ateam data', () => {
    const h = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-fake-home-')));
    for (const d of ['.ssh', '.ateam', 'code/app']) mkdirSync(join(h, d), { recursive: true });
    expect(resolveProjectPath('~', h).error).toContain('home');
    expect(resolveProjectPath('/', h).error).toBeTruthy();
    expect(resolveProjectPath('~/.ssh', h).error).toContain('.ssh');
    expect(resolveProjectPath('~/.ateam', h).error).toContain('.ateam');
    expect(resolveProjectPath('~/missing', h).error).toContain('no such folder');
    expect(resolveProjectPath('~/code/app', h).root).toBe(join(h, 'code', 'app'));
    expect(resolveProjectPath('code/app', h).root).toBe(join(h, 'code', 'app'));
    rmSync(h, { recursive: true, force: true });
  });
});

describe('access requests', () => {
  it('needs an approved client, asks the user once, then grants per project', () => {
    const access = new ExternalAccess(home, () => [repo]);
    access.touch('relay', 'Web connectors');
    expect(() => access.requestAccess('relay', repo, ['execute'], 'build')).toThrow('client_not_approved');
    access.decide('relay', true, [repo]);
    expect(access.can('relay', repo, 'execute')).toBe(false);
    const first = access.requestAccess('relay', repo, ['execute'], 'run the build');
    const again = access.requestAccess('relay', repo, ['git_commit'], 'and commit');
    expect(again.request_id).toBe(first.request_id); // merged, one dialog
    expect(access.status().requests?.[0]?.capabilities).toEqual(['execute', 'git_commit']);
    access.decideRequest(first.request_id as string, true);
    expect(access.can('relay', repo, 'execute')).toBe(true);
    expect(access.can('relay', repo, 'git_push')).toBe(false);
    expect(access.requestAccess('relay', repo, ['execute'], 'x').status).toBe('already_granted');
    expect(access.authorizations('relay').granted[0]?.capabilities).toEqual(['read', 'message', 'execute', 'git_commit']);
    access.revoke('relay');
    expect(access.can('relay', repo, 'execute')).toBe(false);
  });
});

describe('granted actions', () => {
  const exec = () => new ExternalExec(home);
  const ctx = { clientId: 'c', root: '' };

  it('runs commands with masked output and refuses the floor list', async () => {
    const x = exec();
    const run = await runCommand(x, { ...ctx, root: repo }, 'echo hello; echo token=sk-abcdefghijklmnopqrstuv');
    expect(run.status).toBe('exited');
    expect(run.exit_code).toBe(0);
    expect(run.output).toContain('hello');
    expect(run.output).not.toContain('sk-abcdefghijklmnopqrstuv');
    expect(() => x.get('other-client', run.execution_id)).toThrow('execution_not_found');
    for (const bad of ['sudo ls', 'git push --force origin main', 'git push -f', 'rm -rf ~', 'rm -rf /', 'cd x && sudo make'])
      expect(refusedCommand(bad), bad).toBeTruthy();
    for (const ok of ['rm -rf build', 'pnpm test', 'git push origin main', 'echo sudoku'])
      expect(refusedCommand(ok), ok).toBeUndefined();
    await expect(runCommand(x, { ...ctx, root: repo }, 'sudo id')).rejects.toThrow('refused');
    const audit = readFileSync(join(home, 'external-mcp', 'audit.log'), 'utf8');
    expect(audit).toContain('"tool":"run_command"');
    expect(audit).not.toContain('sk-abcdefghijklmnopqrstuv');
  });

  it('forwards an explicit session link to run_command updates', async () => {
    const updates: string[] = [];
    const x = new ExternalExec(home, (run) => updates.push(run.status));
    const run = await runCommand(
      x,
      {
        ...ctx,
        root: repo,
        link: { sessionId: 'runtime-linked', stableSessionId: 'cli-linked' },
      },
      'echo linked',
    );

    expect(run.status).toBe('exited');
    expect(updates).toContain('running');
    expect(updates.at(-1)).toBe('exited');
    expect(x.listLinked('cli-linked', 'runtime-linked')[0]).toMatchObject({
      tool: 'run_command',
      output: expect.stringContaining('linked'),
    });
  });

  it('kills a command at its timeout', async () => {
    const run = await runCommand(exec(), { ...ctx, root: repo }, 'sleep 5', 1);
    expect(run.status).toBe('timed_out');
  });

  it('commits only safe files and pushes without force', async () => {
    const x = exec();
    const files = new ProjectTools(() => repo);
    const c = {
      clientId: 'c',
      root: repo,
      projectId: 'p',
      link: { sessionId: 'runtime-action', stableSessionId: 'cli-action' },
    };
    writeFileSync(join(repo, '.env'), 'SECRET=1');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    await expect(gitCommit(x, files, c, 'leak')).rejects.toThrow('restricted files (.env)');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe(''); // nothing staged on refusal
    const done = await gitCommit(x, files, c, 'update a', ['a.txt']);
    expect(done.exit_code).toBe(0);
    expect(x.listLinked('cli-action', 'runtime-action')[0]?.tool).toBe('git_commit');
    expect('subject' in done && done.subject).toContain('update a'); // a global hook may prefix it
    expect('commit' in done && done.commit).toMatch(/^[0-9a-f]{40}$/);
    await expect(gitPush(x, { clientId: 'c', root: repo }, '--force')).rejects.toThrow('plain names');
    const pushed = await gitPush(x, { clientId: 'c', root: repo, link: c.link }, 'origin', 'main');
    expect(pushed.exit_code).toBe(0);
    expect(x.listLinked('cli-action', 'runtime-action')[0]?.tool).toBe('git_push');
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toContain('update a');
  });
});
