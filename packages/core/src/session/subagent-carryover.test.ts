import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySubagents, subagentCarryoverBlock, subagentsDir } from './subagent-carryover';

describe('sub-agents carried across a hand-off', () => {
  let home: string;
  let prevHome: string | undefined;
  const cwd = '/tmp/ateam-carry-spec';
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'carry-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('copies the log and the meta into the successor, and leaves the original', () => {
    const src = subagentsDir(cwd, 'old-sess');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'agent-a1.jsonl'), '{"type":"user"}\n');
    writeFileSync(join(src, 'agent-a1.meta.json'), '{"description":"Count to five"}');
    const moved = copySubagents(
      { cwd, claudeSessionId: 'old-sess' },
      { cwd, claudeSessionId: 'new-sess' },
      ['a1', 'gone'],
    );
    expect(moved).toEqual(['a1']);
    const dst = subagentsDir(cwd, 'new-sess');
    expect(readFileSync(join(dst, 'agent-a1.jsonl'), 'utf8')).toBe('{"type":"user"}\n');
    expect(readFileSync(join(dst, 'agent-a1.meta.json'), 'utf8')).toContain('Count to five');
    expect(readFileSync(join(src, 'agent-a1.jsonl'), 'utf8')).toBe('{"type":"user"}\n');
  });

  it('tells the successor which agents to continue, and how', () => {
    const block = subagentCarryoverBlock([
      { agentId: 'a1', task: 'count', label: 'Count to five', startedAt: '', lastAt: '', turns: 1, done: false },
    ]);
    expect(block).toContain('--- SUB-AGENTS CARRIED OVER ---');
    expect(block).toContain('- a1 — Count to five');
    expect(block).toContain('SendMessage(to: "<id>"');
    expect(subagentCarryoverBlock([])).toBe('');
  });
});
