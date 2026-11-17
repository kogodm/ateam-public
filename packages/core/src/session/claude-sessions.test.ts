import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeProjectDir, clearClaudeBridgePointer } from './claude-sessions';

const PROJECTS = join(homedir(), '.claude', 'projects');

describe('claudeProjectDir slug encoding', () => {
  // Anonymized mappings exercise the encoding used by on-disk Claude Code dirs.
  // Regression guard: a prior bug only replaced `/`, so any path with `_`/`.`
  // resolved to a non-existent dir and broke session-name + reflect.
  it('replaces every non-alphanumeric char with "-" (incl. leading /)', () => {
    expect(claudeProjectDir('/Users/sample/PycharmProjects/ATeam')).toBe(
      join(PROJECTS, '-Users-sample-PycharmProjects-ATeam'),
    );
  });

  it('collapses underscores to "-" (not just slashes)', () => {
    expect(claudeProjectDir('/Users/sample/projects/workspace/workspace_server_lambda')).toBe(
      join(PROJECTS, '-Users-sample-projects-workspace-workspace-server-lambda'),
    );
  });

  it('collapses dots and preserves letter case + digits', () => {
    expect(claudeProjectDir('/srv/App2/v1.2.3')).toBe(join(PROJECTS, '-srv-App2-v1-2-3'));
  });
});

describe('clearClaudeBridgePointer', () => {
  let prevHome: string | undefined;
  const scratch: string[] = [];

  afterEach(() => {
    if (prevHome === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined stores the word "undefined"
      delete process.env.HOME;
    } else process.env.HOME = prevHome;
    prevHome = undefined;
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function sandbox(): { home: string; cwd: string } {
    prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), 'ateam-bridge-pointer-'));
    scratch.push(home);
    process.env.HOME = home;
    return { home, cwd: join(home, 'Work', 'app_v1') };
  }

  it('deletes the project pointer and leaves the session transcript', () => {
    const { cwd } = sandbox();
    const dir = claudeProjectDir(cwd);
    mkdirSync(dir, { recursive: true });
    const pointer = join(dir, 'bridge-pointer.json');
    const transcript = join(dir, '11111111-2222-4333-8444-555555555555.jsonl');
    writeFileSync(pointer, '{"channel":"old"}\n');
    writeFileSync(transcript, '{"type":"user"}\n');

    clearClaudeBridgePointer(cwd);

    expect(() => readFileSync(pointer)).toThrow();
    expect(readFileSync(transcript, 'utf8')).toBe('{"type":"user"}\n');
  });

  it('does not touch another project, and a missing pointer changes nothing', () => {
    const { cwd } = sandbox();
    const other = claudeProjectDir(join(cwd, 'other'));
    mkdirSync(other, { recursive: true });
    const kept = join(other, 'bridge-pointer.json');
    writeFileSync(kept, '{"channel":"keep"}\n');

    clearClaudeBridgePointer(cwd);
    clearClaudeBridgePointer(cwd);

    expect(readFileSync(kept, 'utf8')).toBe('{"channel":"keep"}\n');
  });
});
