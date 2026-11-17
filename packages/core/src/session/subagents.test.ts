import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listSubagents, tailState } from './subagents';
import { sessionTasksDir } from './tasks-dir';

const dir = mkdtempSync(join(tmpdir(), 'subagents-'));
const taskDir = sessionTasksDir(dir, 'sort-fixture');
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(taskDir, '..', '..'), { recursive: true, force: true });
});

const rec = (type: string, content: unknown, stop_reason?: string) =>
  JSON.stringify({ type, isSidechain: true, agentId: 'a1', message: { content, stop_reason } });
const write = (name: string, lines: string[]) => {
  const p = join(dir, name);
  writeFileSync(p, `${lines.join('\n')}\n`);
  return p;
};

describe('listSubagents order', () => {
  it('keeps creation order and agentId ties across activity and completion updates', () => {
    mkdirSync(taskDir, { recursive: true });
    const startedAt = '2026-10-09T09:00:00.000Z';
    for (const agentId of ['b', 'a', 'c']) {
      const timestamp = agentId === 'c' ? '2026-10-09T08:00:00.000Z' : startedAt;
      writeFileSync(
        join(taskDir, `${agentId}.output`),
        `${JSON.stringify({ type: 'user', isSidechain: true, agentId, timestamp, message: { content: 'Fixture task' } })}\n`,
      );
    }
    const ids = () => listSubagents(dir, 'sort-fixture').map((agent) => agent.agentId);
    expect(ids()).toEqual(['c', 'a', 'b']);
    const file = join(taskDir, 'c.output');
    appendFileSync(file, `${rec('assistant', [{ type: 'text', text: 'Done' }], 'end_turn')}\n`);
    expect(ids()).toEqual(['c', 'a', 'b']);
    expect(listSubagents(dir, 'sort-fixture')[0]).toMatchObject({ done: true, activity: 'Done' });
    appendFileSync(file, `${rec('user', 'Continue fixture')}\n`);
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    expect(ids()).toEqual(['c', 'a', 'b']);
    expect(listSubagents(dir, 'sort-fixture')[0]).toMatchObject({ done: false });
  });
});

describe('tailState', () => {
  it('done once its last word is a final answer', () => {
    const p = write('done.jsonl', [
      rec('user', 'task'),
      rec('assistant', [{ type: 'text', text: 'Report delivered.' }], 'end_turn'),
      JSON.stringify({ type: 'attachment', attachment: {} }),
    ]);
    expect(tailState(p)).toEqual({ done: true, activity: 'Report delivered.' });
  });
  it('done even when the CLI leaves stop_reason null (09-22), once it has gone quiet', () => {
    // v2.1.278 writes null there on a quarter of the agents; requiring
    // 'end_turn' left every one of them in the panel, clock running
    const p = write('nullstop.jsonl', [
      rec('user', 'task'),
      rec('assistant', [{ type: 'text', text: '已完成 part8 的 106 条提示词' }]),
    ]);
    expect(tailState(p).done).toBe(false); // just written: may be mid-reply
    const old = new Date(Date.now() - 4 * 60_000);
    utimesSync(p, old, old);
    expect(tailState(p).done).toBe(true);
  });
  it('still working while a reply is being written block by block (09-28)', () => {
    // one reply lands as several records: thinking, text, then the tool_use
    const thinking = write('thinking.jsonl', [
      rec('user', 'task'),
      rec('assistant', [{ type: 'thinking', thinking: 'plan' }]),
    ]);
    expect(tailState(thinking).done).toBe(false);
    const text = write('midtext.jsonl', [
      rec('user', 'task'),
      rec('assistant', [{ type: 'text', text: 'Now checking the config.' }], 'tool_use'),
    ]);
    expect(tailState(text).done).toBe(false);
    const quietThinking = new Date(Date.now() - 60 * 60_000);
    utimesSync(thinking, quietThinking, quietThinking);
    expect(tailState(thinking).done).toBe(true); // an hour on one thought: it died
  });
  it('not done while it waits on a tool', () => {
    const p = write('waiting.jsonl', [
      rec('assistant', [
        { type: 'text', text: 'reading it now' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/w/a.ts' } },
      ]),
    ]);
    expect(tailState(p).done).toBe(false);
  });
  it('running again after a new message reaches it', () => {
    const p = write('again.jsonl', [
      rec('assistant', [{ type: 'text', text: 'Sent.' }], 'end_turn'),
      rec('user', 'one more thing'),
    ]);
    expect(tailState(p).done).toBe(false);
  });
  it('reads past a screenshot-sized tool result to what it is doing (09-15)', () => {
    const p = write('big.jsonl', [
      rec(
        'assistant',
        [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/l27.png' } }],
        'tool_use',
      ),
      rec('user', [{ type: 'tool_result', content: 'x'.repeat(1_000_000) }]),
    ]);
    expect(tailState(p)).toEqual({ done: false, activity: 'Read · /tmp/l27.png' });
  });
  it('token count from its latest real usage, past an all-zero interrupt record', () => {
    const withUsage = (content: unknown, usage: Record<string, number>) =>
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        agentId: 'a1',
        message: { content, usage },
      });
    const p = write('tokens.jsonl', [
      withUsage([{ type: 'text', text: 'early' }], { input_tokens: 5, output_tokens: 5 }),
      withUsage([{ type: 'text', text: 'working' }], {
        input_tokens: 3,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 44000,
        output_tokens: 200,
      }),
      withUsage([{ type: 'text', text: 'No response requested.' }], {
        input_tokens: 0,
        output_tokens: 0,
      }),
    ]);
    expect(tailState(p).tokens).toBe(45203);
  });
  it('a stopped agent is done, not forever running (09-21)', () => {
    const p = write('stopped.jsonl', [
      rec('assistant', [{ type: 'text', text: 'Let me build the prompts file.' }]),
      rec('user', [{ type: 'text', text: '[Request interrupted by user]' }]),
    ]);
    expect(tailState(p).done).toBe(true);
  });
  it('an agent that never answered what was sent to it is done once it goes quiet', () => {
    const p = write('silent.jsonl', [
      rec('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }], 'tool_use'),
      rec('user', 'have another look at the third one'),
    ]);
    const old = new Date(Date.now() - 40 * 60_000);
    utimesSync(p, old, old);
    expect(tailState(p).done).toBe(true);
  });
});
