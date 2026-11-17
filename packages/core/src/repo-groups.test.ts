import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearRepoGroupCache, repoGroup } from './workspace-info';

/**
 * Grouping a session under its project costs one `git rev-parse` fork per
 * distinct directory — ~433ms across 26 projects, paid on the first tree build
 * of EVERY launch, right while sessions are restoring. The mapping almost
 * never changes, so it is remembered on disk; what must not be remembered is
 * "this is not a repo", which is exactly the answer that goes stale.
 */
describe('repo grouping is remembered across launches', () => {
  let home: string;
  let prevHome: string | undefined;
  let repo: string;

  const groupsFile = () => join(home, 'repo-groups.json');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-groups-spec-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
    repo = mkdtempSync(join(tmpdir(), 'ateam-groups-repo-'));
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    clearRepoGroupCache();
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: unsetting an env var is the point
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    clearRepoGroupCache();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const flush = () => new Promise<void>((r) => setTimeout(() => r(), 1200));

  it('resolves a repo and writes the mapping to disk', async () => {
    const g = repoGroup(repo);
    expect(g.key).toMatch(/\.git$/);
    await flush();
    const saved = JSON.parse(readFileSync(groupsFile(), 'utf8')) as {
      version: number;
      entries: Record<string, { key: string }>;
    };
    expect(saved.version).toBe(1);
    expect(saved.entries[repo]?.key).toBe(g.key);
  });

  it('uses the saved mapping after a restart', async () => {
    const first = repoGroup(repo);
    await flush();
    clearRepoGroupCache(); // a fresh launch: memory empty, only the file remains
    expect(repoGroup(repo)).toEqual(first);
  });

  it('drops a saved mapping whose repo has gone away', async () => {
    const gone = join(home, 'moved-away');
    mkdirSync(gone);
    writeFileSync(
      groupsFile(),
      JSON.stringify({
        version: 1,
        entries: { [gone]: { key: '/definitely/not/here/.git', name: 'ghost' } },
      }),
    );
    clearRepoGroupCache();
    // the stored .git is gone, so the entry must not be trusted — grouping
    // sessions under a project that no longer exists is worse than re-deriving
    expect(repoGroup(gone).name).not.toBe('ghost');
  });

  it('NEVER remembers "not a repo" — git init later must be seen', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ateam-groups-plain-'));
    try {
      expect(repoGroup(plain).key).toBe(plain); // fallback: grouped by its own path
      await flush();
      const saved = existsSync(groupsFile())
        ? (JSON.parse(readFileSync(groupsFile(), 'utf8')) as { entries: Record<string, unknown> })
        : { entries: {} };
      expect(saved.entries[plain]).toBeUndefined();

      execFileSync('git', ['init', '-q', plain], { stdio: 'ignore' });
      clearRepoGroupCache();
      expect(repoGroup(plain).key).toMatch(/\.git$/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('answers "no repo" without forking git when nothing is above it', () => {
    const plain = join(home, 'nested', 'deep', 'leaf');
    mkdirSync(plain, { recursive: true });
    // /tmp has no .git above it, so this must resolve from the filesystem
    // alone — the fork is what used to cost 14ms per non-repo dir per launch
    const t = performance.now();
    const g = repoGroup(plain);
    expect(g.key).toBe(plain);
    expect(performance.now() - t).toBeLessThan(10);
  });
});
