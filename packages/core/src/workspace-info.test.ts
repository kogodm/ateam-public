import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverRepos, repoGroup } from './workspace-info';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
};

describe('repoGroup', () => {
  let root: string;
  let repo: string;
  let worktree: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ateam-repogroup-'));
    repo = join(root, 'main');
    worktree = join(root, 'wt');
    execFileSync('git', ['init', repo], { stdio: 'ignore' });
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'commit', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-b', 'feat', worktree);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('groups a worktree under the same key + name as its main checkout', () => {
    const a = repoGroup(repo);
    const b = repoGroup(worktree);
    expect(b.key).toBe(a.key); // both resolve to the shared .git common dir
    expect(a.name).toBe(basename(repo)); // "main"
    expect(b.name).toBe(a.name);
  });

  it('falls back to the dir itself when it is not a git repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'ateam-nogit-'));
    const g = repoGroup(plain);
    expect(g.key).toBe(plain);
    expect(g.name).toBe(basename(plain));
    rmSync(plain, { recursive: true, force: true });
  });
});

describe('discoverRepos', () => {
  let root: string;

  beforeAll(() => {
    // A parent folder holding two repos plus a nested one — mirrors the
    // proxyrouter/{ProxyRouter, web} layout.
    root = mkdtempSync(join(tmpdir(), 'ateam-discover-'));
    for (const name of ['app', 'web']) {
      execFileSync('git', ['init', join(root, name)], { stdio: 'ignore' });
    }
    mkdirSync(join(root, 'app', 'vendor'), { recursive: true });
    execFileSync('git', ['init', join(root, 'app', 'vendor', 'lib')], { stdio: 'ignore' });
    mkdirSync(join(root, 'docs'), { recursive: true }); // plain dir, no repo
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('returns the sub-repos when the dir itself is not a repo', () => {
    expect(discoverRepos(root)).toEqual([join(root, 'app'), join(root, 'web')]);
  });

  it('returns only itself when the dir is a repo (no digging into submodules)', () => {
    expect(discoverRepos(join(root, 'app'))).toEqual([join(root, 'app')]);
  });

  it('is empty for a plain dir with no repos anywhere under it', () => {
    expect(discoverRepos(join(root, 'docs'))).toEqual([]);
  });
});
