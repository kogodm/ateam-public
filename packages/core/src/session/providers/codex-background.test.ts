import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexLogPath, listCodexBackground, readCodexBackground } from './codex-background';
import {
  codexExecBatch,
  codexExecBatchResults,
  codexExecCall,
  codexExecResult,
} from './codex-exec-call';

const PARENT = '11111111-1234-4123-8123-111111111111';
const CHILD = '22222222-1234-4123-8123-222222222222';
let home: string;
let file: string;
const at = new Date().toISOString();
function append(type: string, payload: Record<string, unknown>, target = file) {
  appendFileSync(target, `${JSON.stringify({ type, timestamp: at, payload })}\n`);
}
function create(id: string, parent?: string) {
  const path = join(home, 'sessions/2026/01/01', `rollout-test-${id}.jsonl`);
  writeFileSync(path, '');
  append(
    'session_meta',
    {
      id,
      cwd: home,
      source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : 'cli',
    },
    path,
  );
  return path;
}
function call(id: string, command: string, target = file) {
  append(
    'response_item',
    {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: id,
      input: `text(await tools.exec_command({cmd:${JSON.stringify(command)}}));`,
    },
    target,
  );
}
function result(id: string, output: Record<string, unknown>, target = file) {
  append(
    'response_item',
    {
      type: 'custom_tool_call_output',
      call_id: id,
      output: [
        {
          type: 'input_text',
          text: JSON.stringify({ wall_time_seconds: 1, output: '', ...output }),
        },
      ],
    },
    target,
  );
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ateam-codex-bg-'));
  vi.stubEnv('CODEX_HOME', home);
  mkdirSync(join(home, 'sessions/2026/01/01'), { recursive: true });
  file = create(PARENT);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('Codex background command identity', () => {
  it('rejects aliases that could return a different command result', () => {
    expect(
      codexExecCall({
        type: 'custom_tool_call',
        name: 'exec',
        input:
          'const run=tools.exec_command; await tools.exec_command({cmd:"A"}); text(await run({cmd:"B"}));',
      }),
    ).toBeUndefined();
    expect(
      codexExecCall({
        type: 'custom_tool_call',
        name: 'exec',
        input:
          'const alias=tools; await tools.exec_command({cmd:"A"}); text(await alias.exec_command({cmd:"B"}));',
      }),
    ).toBeUndefined();
  });
  it('extracts the actual trailing redirect with the same lexical parser', () => {
    expect(codexLogPath("printf ' > /tmp/private '; sleep 60; echo x>/tmp/actual")).toBe(
      '/tmp/actual',
    );
    expect(codexLogPath("echo ' > /tmp/private' 2>&1")).toBeUndefined();
    expect(codexLogPath('run > /tmp/a > /tmp/b')).toBeUndefined();
    expect(codexLogPath('[[ a > /tmp/private ]]; sleep 60')).toBeUndefined();
    expect(codexLogPath('run > "/tmp/my log" 2>&1')).toBe('/tmp/my log');
    expect(codexLogPath('run > $LOG')).toBeUndefined();
  });
  it('extracts one literal command, without executing scripts', () => {
    expect(
      codexExecCall({
        type: 'custom_tool_call',
        name: 'exec',
        input: 'throw new Error(); text(await tools.exec_command({cmd:"echo ok",workdir:"/tmp"}));',
      }),
    ).toEqual({ kind: 'exec_command', cmd: 'echo ok', cwd: '/tmp' });
    expect(
      codexExecCall({
        type: 'function_call',
        name: 'functions.write_stdin',
        arguments: '{"session_id":123}',
      }),
    ).toEqual({ kind: 'write_stdin', processId: '123' });
  });
  it('refuses ambiguous batches, dynamic commands, loops and quoted names', () => {
    for (const input of [
      'text("tools.exec_command({cmd:1})")',
      'await tools.exec_command({cmd:command});',
      'await tools.exec_command({cmd:"one"}); await tools.exec_command({cmd:"two"});',
      'for(;;) await tools.exec_command({cmd:"one"});',
    ])
      expect(codexExecCall({ type: 'custom_tool_call', name: 'exec', input })).toBeUndefined();
  });
  it('does not mistake orchestration cell ids or logged JSON for process results', () => {
    expect(codexExecResult('Script running with cell ID 123')).toBeUndefined();
    expect(
      codexExecResult([{ type: 'input_text', text: 'A log mentioned {"session_id":123}' }]),
    ).toBeUndefined();
    expect(
      codexExecResult([
        { session_id: 123, output: 'a', wall_time_seconds: 1 },
        { session_id: 456, output: 'b', wall_time_seconds: 1 },
      ]),
    ).toBeUndefined();
  });
});

describe('Codex background progress', () => {
  it('pairs a batched exit with its poll instead of another command or image', () => {
    call('start', 'run-job');
    result('start', { session_id: 123 });
    append('response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'batch',
      input:
        'text(await tools.exec_command({cmd:"cat log"})); image((await tools.view_image({path:"/tmp/a.png"})).image_url); text(await tools.write_stdin({session_id:123,chars:""}));',
    });
    append('response_item', {
      type: 'custom_tool_call_output',
      call_id: 'batch',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' },
        {
          type: 'input_text',
          text: JSON.stringify({ wall_time_seconds: 1, exit_code: 0, output: 'log' }),
        },
        { type: 'input_image', image_url: 'unused' },
        {
          type: 'input_text',
          text: JSON.stringify({ wall_time_seconds: 1, exit_code: 7, output: 'failed' }),
        },
      ],
    });
    expect(listCodexBackground(PARENT)[0]).toMatchObject({ done: true, exitCode: 7 });
  });
  it('does not infer an exit from an ambiguous, reordered or truncated batch', () => {
    for (const input of [
      'text(await Promise.all([tools.write_stdin({session_id:123}),tools.exec_command({cmd:"x"})]));',
      'const tools=other; text(await tools.write_stdin({session_id:123}));',
      'const result=await tools.write_stdin({session_id:123}); text(result);',
      'if(flag) text(await tools.write_stdin({session_id:123}));',
      'text("pretend result"); text(await tools.write_stdin({session_id:123}));',
    ])
      expect(codexExecBatch({ type: 'custom_tool_call', name: 'exec', input })).toBeUndefined();
    expect(
      codexExecBatchResults(
        [
          {
            type: 'input_text',
            text: JSON.stringify({ wall_time_seconds: 1, exit_code: 0, output: '' }),
          },
        ],
        2,
      ),
    ).toBeUndefined();
  });
  it('keeps unconfirmed historical jobs out of active status until a fresh poll', () => {
    appendFileSync(
      file,
      `${JSON.stringify({ type: 'response_item', timestamp: '2000-01-01T00:00:00Z', payload: { type: 'function_call', name: 'exec_command', call_id: 'old', arguments: '{"cmd":"run"}' } })}\n`,
    );
    appendFileSync(
      file,
      `${JSON.stringify({ type: 'response_item', timestamp: '2000-01-01T00:00:01Z', payload: { type: 'function_call_output', call_id: 'old', output: JSON.stringify({ wall_time_seconds: 1, session_id: 123, output: '进度 1/3' }) } })}\n`,
    );
    expect(listCodexBackground(PARENT)[0]).toMatchObject({ done: false, statusUnknown: true });
    expect(listCodexBackground(PARENT)[0]?.progress).toBeUndefined();
    append('response_item', {
      type: 'function_call',
      name: 'write_stdin',
      call_id: 'fresh',
      arguments: '{"session_id":123}',
    });
    result('fresh', { session_id: 123, output: '进度 2/3' });
    expect(listCodexBackground(PARENT)[0]).toMatchObject({
      done: false,
      statusUnknown: false,
      progress: { done: 2 },
    });
  });
  it('retries partial records and resets after transcript truncation', () => {
    const record = JSON.stringify({
      timestamp: at,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'partial',
        arguments: '{"cmd":"run"}',
      },
    });
    appendFileSync(file, record.slice(0, 30));
    expect(listCodexBackground(PARENT)).toEqual([]);
    appendFileSync(file, `${record.slice(30)}\n`);
    result('partial', { session_id: 123 });
    expect(listCodexBackground(PARENT)).toHaveLength(1);
    file = create(PARENT);
    expect(listCodexBackground(PARENT)).toEqual([]);
  });
  it('merges native exit that arrived before the wrapper printed its startup result', () => {
    call('start', 'run-job');
    append('event_msg', {
      type: 'item_completed',
      item: { type: 'CommandExecution', process_id: '123', status: 'completed', exit_code: 0 },
    });
    result('start', { session_id: 123, output: 'early chunk' });
    expect(listCodexBackground(PARENT)[0]).toMatchObject({ done: true, exitCode: 0 });
  });
  it('follows a reported process and reads its redirected log live without driving the CLI', () => {
    const log = join(home, 'progress.log');
    writeFileSync(log, '进度 1/4\n');
    call('start', `run-job > ${log} 2>&1`);
    result('start', { session_id: 123, exit_code: null });
    const first = listCodexBackground(PARENT)[0];
    expect(first).toMatchObject({ done: false, progress: { done: 1, total: 4, pct: 25 } });
    appendFileSync(log, '进度 2/4\n');
    expect(listCodexBackground(PARENT)[0]?.progress?.pct).toBe(50);
    expect(readCodexBackground(PARENT, first?.id ?? '')).toMatchObject({
      text: '进度 1/4\n进度 2/4\n',
      logPath: log,
      done: false,
    });
  });
  it('pairs write_stdin results and closes only on an explicit process exit', () => {
    call('start', 'run-job');
    result('start', { session_id: 123, output: '进度 1/3\n' });
    const id = listCodexBackground(PARENT)[0]?.id ?? '';
    append('event_msg', { type: 'task_complete' });
    expect(listCodexBackground(PARENT)[0]?.done).toBe(false);
    append('response_item', {
      type: 'function_call',
      name: 'write_stdin',
      call_id: 'poll',
      arguments: '{"session_id":123}',
    });
    result('poll', { exit_code: 7, output: 'failed\n' });
    expect(listCodexBackground(PARENT)[0]).toMatchObject({ done: true, exitCode: 7 });
    expect(readCodexBackground(PARENT, id).text).toContain('failed');
  });
  it('matches native command completion by process_id, not by the wrapper call id', () => {
    call('start', 'run-job');
    result('start', { session_id: 123 });
    append('event_msg', {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id: 'unrelated-wrapper-id',
        process_id: '123',
        status: 'completed',
        exit_code: 0,
      },
    });
    expect(listCodexBackground(PARENT)[0]).toMatchObject({ done: true, exitCode: 0 });
  });
  it('does not manufacture a background task from foreground completion', () => {
    call('foreground', 'echo ok');
    result('foreground', { exit_code: 0, output: 'ok' });
    expect(listCodexBackground(PARENT)).toEqual([]);
    expect(readCodexBackground(PARENT, '/etc/passwd')).toEqual({
      text: '',
      bytes: 0,
      truncated: false,
      done: true,
    });
  });
  it('does not treat quoted redirects as live output', () => {
    const log = join(home, 'not-a-log');
    writeFileSync(log, '进度 9/9 private');
    call('quoted', `echo 'not a redirect > ${log}' 2>&1`);
    result('quoted', { session_id: 123, output: '进度 1/4\n' });
    expect(listCodexBackground(PARENT)[0]?.progress?.pct).toBe(25);
    expect(
      readCodexBackground(PARENT, listCodexBackground(PARENT)[0]?.id ?? '').logPath,
    ).toBeUndefined();
  });
  it('keeps process IDs scoped to verified child threads', () => {
    const child = create(CHILD, PARENT);
    append('event_msg', {
      type: 'item_completed',
      item: { type: 'CollabAgentToolCall', receiver_thread_ids: [CHILD] },
    });
    call('parent', 'parent-job');
    result('parent', { session_id: 123 });
    call('child', 'child-job', child);
    result('child', { session_id: 123, output: '进度 2/5' }, child);
    const rows = listCodexBackground(PARENT);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.find((row) => row.agentId === CHILD)?.progress?.pct).toBe(40);
  });
  it('does not read a log again after the process exited', () => {
    const log = join(home, 'progress.log');
    writeFileSync(log, '进度 1/2');
    call('start', `run > ${log}`);
    result('start', { session_id: 123 });
    const id = listCodexBackground(PARENT)[0]?.id ?? '';
    append('event_msg', {
      type: 'item_completed',
      item: { type: 'CommandExecution', process_id: '123', status: 'completed', exit_code: 0 },
    });
    writeFileSync(log, 'A different task');
    expect(readCodexBackground(PARENT, id).text).toBe('进度 1/2');
  });
  it('matches native command completion by command array without process_id', () => {
    call('start', 'python3 -m py_compile formalize_current.py');
    result('start', { session_id: 456 });
    expect(listCodexBackground(PARENT)).toHaveLength(1);
    expect(listCodexBackground(PARENT)[0]?.done).toBe(false);
    append('event_msg', {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id: 'cmd-native-1',
        command: ['/bin/zsh', '-lc', 'python3 -m py_compile formalize_current.py'],
        exit_code: 0,
      },
    });
    expect(listCodexBackground(PARENT)[0]).toMatchObject({ done: true, exitCode: 0 });
  });
  it('marks silent tasks without log as statusUnknown after inactivity', () => {
    const oldTime = new Date(Date.now() - 400_000).toISOString();
    appendFileSync(
      file,
      `${JSON.stringify({ type: 'response_item', timestamp: oldTime, payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"scp -q a b"}' } })}\n`,
    );
    appendFileSync(
      file,
      `${JSON.stringify({ type: 'response_item', timestamp: oldTime, payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ wall_time_seconds: 1, session_id: 789, output: '' }) } })}\n`,
    );
    expect(listCodexBackground(PARENT)[0]).toMatchObject({ done: false, statusUnknown: true });
  });
  it('marks finished subagent tasks as statusUnknown after silence', () => {
    const child = create(CHILD, PARENT);
    append('event_msg', {
      type: 'item_completed',
      item: { type: 'CollabAgentToolCall', receiver_thread_ids: [CHILD] },
    });
    const subTime = new Date(Date.now() - 40_000).toISOString();
    appendFileSync(
      child,
      `${JSON.stringify({ type: 'response_item', timestamp: subTime, payload: { type: 'function_call', name: 'exec_command', call_id: 'child-c', arguments: '{"cmd":"child-task"}' } })}\n`,
    );
    appendFileSync(
      child,
      `${JSON.stringify({ type: 'response_item', timestamp: subTime, payload: { type: 'function_call_output', call_id: 'child-c', output: JSON.stringify({ wall_time_seconds: 1, session_id: 999, output: '' }) } })}\n`,
    );
    // Mark child as completed / idle
    appendFileSync(
      child,
      `${JSON.stringify({ type: 'event_msg', timestamp: subTime, payload: { type: 'task_complete' } })}\n`,
    );
    const rows = listCodexBackground(PARENT);
    const childJob = rows.find((r) => r.agentId === CHILD);
    expect(childJob).toMatchObject({ done: false, statusUnknown: true });
  });
});
