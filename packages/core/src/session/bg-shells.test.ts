import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listBackgroundShells } from './bg-shells';
import { claudeProjectDir } from './claude-sessions';
import { sessionTasksDir } from './tasks-dir';

const cwd = `/tmp/ateam-bgshells-test-${process.pid}`;
const sid = 'test-session';
const tasks = sessionTasksDir(cwd, sid);
const results = join(claudeProjectDir(cwd), sid, 'tool-results');
afterAll(() => {
  rmSync(join(tasks, '..', '..'), { recursive: true, force: true });
  rmSync(claudeProjectDir(cwd), { recursive: true, force: true });
});

describe('listBackgroundShells', () => {
  it('tells running from finished without an exit marker at the very end', () => {
    mkdirSync(tasks, { recursive: true });
    mkdirSync(results, { recursive: true });
    // still going
    writeFileSync(join(tasks, 'brun00001.output'), 'step 3/10\n');
    // timed out → moved to background → marker, then its process kept printing
    writeFileSync(join(tasks, 'btime0001.output'), '\n[exited with code 144]\nPingFang SC=true\n');
    // a finished foreground command whose big output claude saved (b37eyihd3, 09-15)
    writeFileSync(join(tasks, 'bbig00001.output'), '# Mahjong Trix 玩法机制 × 广告卖点\n95%\n');
    writeFileSync(join(results, 'bbig00001.txt'), '# Mahjong Trix …');
    const byId = Object.fromEntries(listBackgroundShells(cwd, sid).map((s) => [s.id, s]));
    expect(byId.brun00001?.done).toBe(false);
    expect(byId.btime0001).toMatchObject({ done: true, exitCode: 144 });
    expect(byId.bbig00001?.done).toBe(true);
  });
});
