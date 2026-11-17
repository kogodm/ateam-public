import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listCodexSubagents, readCodexSubagentTranscript } from './codex-subagents';
import * as codexTranscript from './codex-transcript';

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const AT = '2026-10-08T12:00:00.000Z';
let home: string;
let parentFile: string;
let childFile: string;
const event = (payload: Record<string, unknown>) =>
  `${JSON.stringify({ timestamp: AT, type: 'event_msg', payload })}\n`;
const item = (value: Record<string, unknown>) => event({ type: 'item_completed', item: value });

function rollout(id: string, parentId?: string, startedAt = AT): string {
  const dir = join(home, 'sessions', '2026', '10', '08');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-test-${id}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({
      timestamp: startedAt,
      type: 'session_meta',
      payload: {
        id,
        cwd: '/fixture',
        timestamp: startedAt,
        source: parentId
          ? { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } }
          : 'cli',
      },
    })}\n`,
  );
  return file;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-agents-'));
  vi.stubEnv('CODEX_HOME', home);
  parentFile = rollout(PARENT);
  childFile = rollout(CHILD, PARENT);
  appendFileSync(
    parentFile,
    item({
      type: 'CollabAgentToolCall',
      id: 'spawn',
      tool: 'spawn_agent',
      status: 'completed',
      prompt: 'Inspect fixture',
      receiver_thread_ids: [CHILD],
      receiver_agents: [{ thread_id: CHILD, agent_nickname: 'Reviewer' }],
      agents_states: { [CHILD]: 'pending_init' },
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('Codex subagents from real rollout shapes', () => {
  it('discovers a child from code-mode structured spawn output without typed events', () => {
    parentFile = rollout(PARENT);
    appendFileSync(
      parentFile,
      `${JSON.stringify({
        timestamp: AT,
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'outer',
          output: [
            { type: 'input_text', text: 'Script completed\nOutput:\n' },
            { type: 'input_text', text: JSON.stringify({ agent_id: CHILD, nickname: 'Rawls' }) },
            {
              type: 'input_text',
              text: JSON.stringify({ chunk_id: 'cmd', output: 'other operation' }),
            },
          ],
        },
      })}\n`,
    );
    appendFileSync(childFile, event({ type: 'task_started' }));
    expect(listCodexSubagents(PARENT)).toMatchObject([
      { agentId: CHILD, label: 'Rawls', status: 'running', done: false },
    ]);
    expect(listCodexSubagents(PARENT)).toHaveLength(1);
  });
  it('still rejects a foreign child and mere mentions in raw outputs', () => {
    parentFile = rollout(PARENT);
    childFile = rollout(CHILD, OTHER);
    appendFileSync(
      parentFile,
      `${JSON.stringify({
        timestamp: AT,
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'spawn',
          output: JSON.stringify({ agent_id: CHILD, nickname: 'Foreign' }),
        },
      })}\n`,
    );
    expect(listCodexSubagents(PARENT)).toEqual([]);
    expect(readCodexSubagentTranscript(PARENT, CHILD)).toEqual([]);
    parentFile = rollout(PARENT);
    childFile = rollout(CHILD, PARENT);
    appendFileSync(
      parentFile,
      `${JSON.stringify({
        timestamp: AT,
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'text',
          output: `Spawned ${CHILD}`,
        },
      })}\n`,
    );
    expect(listCodexSubagents(PARENT)).toEqual([]);
  });
  it('retries a raw-discovered child whose metadata has not arrived', () => {
    parentFile = rollout(PARENT);
    rmSync(childFile);
    appendFileSync(
      parentFile,
      `${JSON.stringify({
        timestamp: AT,
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'spawn',
          output: JSON.stringify({ agent_id: CHILD, nickname: 'Later' }),
        },
      })}\n`,
    );
    expect(listCodexSubagents(PARENT)).toEqual([]);
    childFile = rollout(CHILD, PARENT);
    appendFileSync(childFile, event({ type: 'task_started' }));
    expect(listCodexSubagents(PARENT)).toMatchObject([{ agentId: CHILD, label: 'Later' }]);
  });
  it('discovers legacy sub-agent activity with ownership checks', () => {
    parentFile = rollout(PARENT);
    appendFileSync(
      parentFile,
      event({ type: 'sub_agent_activity', agent_thread_id: CHILD, kind: 'started' }),
    );
    expect(listCodexSubagents(PARENT)).toMatchObject([{ agentId: CHILD, done: false }]);
  });
  it('tracks child raw outputs independently from raw calls', () => {
    appendFileSync(
      childFile,
      `${JSON.stringify({
        timestamp: AT,
        type: 'response_item',
        payload: { type: 'function_call', name: 'fixture', call_id: 'raw', arguments: '{}' },
      })}\n${item({ type: 'FunctionCallOutput', id: 'raw', output: 'native result' })}`,
    );
    expect(readCodexSubagentTranscript(PARENT, CHILD).map((turn) => turn.text)).toEqual([
      '{}',
      'native result',
    ]);
    appendFileSync(
      childFile,
      `${JSON.stringify({
        timestamp: AT,
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'raw', output: 'raw result' },
      })}\n`,
    );
    expect(readCodexSubagentTranscript(PARENT, CHILD).map((turn) => turn.text)).toEqual([
      '{}',
      'raw result',
    ]);
  });

  it('bounds cached child output IDs independently at 20000', () => {
    const collect = vi.spyOn(codexTranscript, 'codexResponseOutputIds');
    collect.mockReturnValueOnce(new Set());
    collect.mockReturnValueOnce(
      new Set(Array.from({ length: 20001 }, (_, index) => `output-${index}`)),
    );
    try {
      appendFileSync(
        childFile,
        item({ type: 'FunctionCallOutput', id: 'output-0', output: 'evicted' }) +
          item({ type: 'FunctionCallOutput', id: 'output-20000', output: 'retained' }),
      );
      listCodexSubagents(PARENT);
      expect(readCodexSubagentTranscript(PARENT, CHILD).map((turn) => turn.text)).toEqual([
        'evicted',
      ]);
    } finally {
      collect.mockRestore();
    }
  });

  it.each(['function_call', 'custom_tool_call'])('raw %s updates activity', (type) => {
    appendFileSync(childFile, event({ type: 'task_started' }));
    appendFileSync(
      childFile,
      `${JSON.stringify({
        timestamp: AT,
        type: 'response_item',
        payload: {
          type,
          name: 'exec_command',
          call_id: 'raw-activity',
          arguments: JSON.stringify({ cmd: 'printf fixture' }),
          input: 'printf fixture',
        },
      })}\n`,
    );
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({
      status: 'running',
      done: false,
      activity: `${type === 'function_call' ? 'Bash' : 'exec_command'} · printf fixture`,
    });
    appendFileSync(
      childFile,
      `${JSON.stringify({
        timestamp: AT,
        type: 'response_item',
        payload: { type: `${type}_output`, call_id: 'raw-activity', output: 'finished' },
      })}\n`,
    );
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ status: 'running', done: false });
  });

  it.each(['task_complete', 'turn_complete'])('%s tracks errors and recovery', (type) => {
    appendFileSync(childFile, event({ type: 'task_started' }));
    appendFileSync(childFile, event({ type, error: { message: 'synthetic failure' } }));
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ status: 'errored', done: true });
    appendFileSync(childFile, event({ type: 'turn_started' }));
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ status: 'running', done: false });
    appendFileSync(childFile, event({ type, error: null }));
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ status: 'idle', done: true });
  });

  it('discovers a verified raw child without inventing its running state', () => {
    parentFile = rollout(PARENT);
    appendFileSync(
      parentFile,
      `${JSON.stringify({
        timestamp: AT,
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'raw-spawn',
          output: JSON.stringify({ agent_id: CHILD }),
        },
      })}\n`,
    );
    expect(listCodexSubagents(PARENT)).toMatchObject([{ agentId: CHILD, status: 'unknown' }]);
  });

  it('bounds cached child response IDs at 20000', () => {
    const collect = vi.spyOn(codexTranscript, 'codexResponseCallIds');
    collect.mockReturnValueOnce(new Set());
    collect.mockReturnValueOnce(
      new Set(Array.from({ length: 20001 }, (_, index) => `call-${index}`)),
    );
    try {
      appendFileSync(
        childFile,
        item({ type: 'ImageView', id: 'call-0', path: '/evicted.png' }) +
          item({ type: 'ImageView', id: 'call-20000', path: '/retained.png' }),
      );
      listCodexSubagents(PARENT);
      expect(readCodexSubagentTranscript(PARENT, CHILD).map((turn) => turn.toolUseId)).toEqual([
        'call-0',
        'call-0',
      ]);
    } finally {
      collect.mockRestore();
    }
  });

  it('deduplicates raw IDs across scans without suppressing independent native child tools', () => {
    const raw = `${JSON.stringify({
      timestamp: AT,
      type: 'response_item',
      payload: { type: 'function_call', name: 'view_image', call_id: 'raw-image', arguments: '{}' },
    })}\n`;
    appendFileSync(
      childFile,
      item({ type: 'ImageView', id: 'raw-image', path: '/duplicate.png' }) + raw,
    );
    expect(readCodexSubagentTranscript(PARENT, CHILD).map((turn) => turn.toolUseId)).toEqual([
      'raw-image',
    ]);
    appendFileSync(
      childFile,
      item({ type: 'ImageView', id: 'raw-image', path: '/duplicate-again.png' }) +
        item({
          type: 'CommandExecution',
          id: 'nested',
          command: ['printf', 'native'],
          exit_code: 0,
        }),
    );
    expect(listCodexSubagents(PARENT)[0]?.activity).toBe('Bash · printf native');
    expect(readCodexSubagentTranscript(PARENT, CHILD).map((turn) => turn.toolUseId)).toEqual([
      'raw-image',
      'nested',
      'nested',
    ]);
  });

  it('keeps creation order and agentId ties across activity and lifecycle updates', () => {
    const third = '44444444-4444-4444-8444-444444444444';
    const otherFile = rollout(OTHER, PARENT, '2026-10-08T11:00:00.000Z');
    rollout(third, PARENT);
    rollout(PARENT);
    appendFileSync(
      parentFile,
      item({
        type: 'CollabAgentToolCall',
        tool: 'spawn_agent',
        receiver_thread_ids: [third, CHILD, OTHER],
        agents_states: { [third]: 'running', [CHILD]: 'running', [OTHER]: 'running' },
      }),
    );
    const ids = () => listCodexSubagents(PARENT).map((agent) => agent.agentId);
    expect(ids()).toEqual([OTHER, CHILD, third]);
    appendFileSync(
      otherFile,
      `${JSON.stringify({ timestamp: '2026-10-08T13:00:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } })}\n`,
    );
    expect(ids()).toEqual([OTHER, CHILD, third]);
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ done: true, status: 'idle' });
    appendFileSync(
      otherFile,
      `${JSON.stringify({ timestamp: '2026-10-08T14:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } })}\n`,
    );
    expect(ids()).toEqual([OTHER, CHILD, third]);
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ done: false, status: 'running' });
  });

  it('reads only the parent references, with a label and the child activity', () => {
    rollout(OTHER, PARENT);
    appendFileSync(
      childFile,
      event({ type: 'task_started' }) +
        item({
          type: 'CommandExecution',
          id: 'cmd',
          command: ['zsh', '-lc', 'echo fixture'],
          aggregated_output: 'fixture',
          status: 'completed',
          exit_code: 0,
        }),
    );
    expect(listCodexSubagents(PARENT)).toMatchObject([
      {
        agentId: CHILD,
        task: 'Inspect fixture',
        label: 'Reviewer',
        done: false,
        activity: 'Bash · echo fixture',
      },
    ]);
    expect(readCodexSubagentTranscript(PARENT, CHILD)).toMatchObject([
      { kind: 'tool_use', toolUseId: 'cmd', sessionId: CHILD },
      { kind: 'tool_result', toolUseId: 'cmd' },
    ]);
  });

  it('does not finish on commentary or tool completion; task_complete finishes, task_started resumes', () => {
    appendFileSync(
      childFile,
      item({
        type: 'AgentMessage',
        phase: 'commentary',
        content: [{ type: 'Text', text: 'Still working' }],
      }),
    );
    expect(listCodexSubagents(PARENT)[0]?.done).toBe(false);
    appendFileSync(childFile, event({ type: 'task_complete' }));
    expect(listCodexSubagents(PARENT)[0]?.done).toBe(true);
    appendFileSync(childFile, event({ type: 'task_started' }));
    expect(listCodexSubagents(PARENT)[0]?.done).toBe(false);
    appendFileSync(childFile, event({ type: 'turn_aborted', reason: 'interrupted' }));
    expect(listCodexSubagents(PARENT)[0]?.done).toBe(true);
  });

  it('deduplicates wait/send_input and retains the initial task and label', () => {
    appendFileSync(
      parentFile,
      item({
        type: 'CollabAgentToolCall',
        tool: 'wait',
        receiver_thread_ids: [CHILD],
        prompt: '',
        agents_states: {},
      }),
    );
    expect(listCodexSubagents(PARENT)).toMatchObject([
      { agentId: CHILD, label: 'Reviewer', task: 'Inspect fixture' },
    ]);
    expect(listCodexSubagents(PARENT)).toHaveLength(1);
  });

  it('exposes a finished child turn as idle, not a closed thread', () => {
    appendFileSync(childFile, event({ type: 'task_complete' }));
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ done: true, status: 'idle' });
    appendFileSync(childFile, event({ type: 'task_started' }));
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ done: false, status: 'running' });
  });

  it('a successful wait without agent states does not finish a running child', () => {
    appendFileSync(childFile, event({ type: 'task_started' }));
    appendFileSync(
      parentFile,
      item({
        type: 'CollabAgentToolCall',
        tool: 'wait',
        status: 'completed',
        receiver_thread_ids: [CHILD],
        agents_states: {},
      }),
    );
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ done: false, status: 'running' });
  });

  it('uses newer parent wait states even if a child turn previously ended', () => {
    appendFileSync(childFile, event({ type: 'task_complete' }));
    const wait = (state: unknown) =>
      `${JSON.stringify({
        timestamp: '2026-10-08T12:01:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CollabAgentToolCall',
            tool: 'wait',
            status: 'completed',
            receiver_thread_ids: [CHILD],
            agents_states: { [CHILD]: state },
          },
        },
      })}\n`;
    appendFileSync(parentFile, wait('running'));
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ done: false, status: 'running' });
    appendFileSync(parentFile, wait({ completed: 'Finished fixture' }));
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ done: true, status: 'idle' });
    appendFileSync(parentFile, wait('shutdown'));
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ done: true, status: 'closed' });
  });

  it('successful close closes a thread, failed close does not, and late activity cannot reopen it', () => {
    const close = (status: string) =>
      item({
        type: 'CollabAgentToolCall',
        tool: 'close_agent',
        status,
        receiver_thread_ids: [CHILD],
        agents_states: {},
      });
    appendFileSync(parentFile, close('failed'));
    expect(listCodexSubagents(PARENT)[0]?.done).toBe(false);
    appendFileSync(parentFile, close('completed'));
    appendFileSync(
      parentFile,
      item({ type: 'SubAgentActivity', agent_thread_id: CHILD, kind: 'started' }),
    );
    expect(listCodexSubagents(PARENT)[0]).toMatchObject({ done: true, status: 'closed' });
  });

  it('hides an unverified activity-only reference until its child metadata arrives', () => {
    appendFileSync(
      parentFile,
      item({ type: 'SubAgentActivity', kind: 'started', agent_thread_id: OTHER, agent_path: null }),
    );
    expect(listCodexSubagents(PARENT).map((agent) => agent.agentId)).not.toContain(OTHER);
    expect(readCodexSubagentTranscript(PARENT, OTHER)).toEqual([]);
    const file = rollout(OTHER, PARENT);
    const metadata = Buffer.from(event({ type: 'task_started' }));
    appendFileSync(file, metadata);
    expect(listCodexSubagents(PARENT).map((agent) => agent.agentId)).toContain(OTHER);
  });

  it('rejects traversal and a child belonging to another parent', () => {
    expect(readCodexSubagentTranscript(PARENT, '../other')).toEqual([]);
    rollout(OTHER, CHILD);
    expect(readCodexSubagentTranscript(PARENT, OTHER)).toEqual([]);
    expect(listCodexSubagents('../parent')).toEqual([]);
  });

  it.each(['CollabAgentToolCall', 'SubAgentActivity'])(
    'rejects foreign references from %s in the listing and conversation',
    (type) => {
      rollout(CHILD, OTHER);
      appendFileSync(
        parentFile,
        item({
          type,
          tool: 'send_input',
          receiver_thread_ids: [CHILD],
          agent_thread_id: CHILD,
          kind: 'started',
          agents_states: { [CHILD]: 'running' },
        }),
      );
      expect(listCodexSubagents(PARENT)).toEqual([]);
      expect(readCodexSubagentTranscript(PARENT, CHILD)).toEqual([]);
    },
  );

  it('rejects a referenced top-level thread with no parent metadata', () => {
    rollout(CHILD);
    expect(listCodexSubagents(PARENT)).toEqual([]);
    expect(readCodexSubagentTranscript(PARENT, CHILD)).toEqual([]);
  });

  it('retries missing and incomplete child metadata without exposing an unverified agent', () => {
    const metadata = rollout(CHILD, PARENT);
    rmSync(metadata);
    expect(listCodexSubagents(PARENT)).toEqual([]);
    expect(readCodexSubagentTranscript(PARENT, CHILD)).toEqual([]);
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: CHILD,
        source: { subagent: { thread_spawn: { parent_thread_id: PARENT } } },
      },
    });
    writeFileSync(childFile, line);
    expect(listCodexSubagents(PARENT)).toEqual([]);
    appendFileSync(childFile, '\n');
    expect(listCodexSubagents(PARENT)).toMatchObject([{ agentId: CHILD }]);
  });

  it('rejects child metadata whose identity differs from the requested thread', () => {
    const replacement = rollout(OTHER, PARENT);
    renameSync(replacement, childFile);
    expect(listCodexSubagents(PARENT)).toEqual([]);
    expect(readCodexSubagentTranscript(PARENT, CHILD)).toEqual([]);
  });

  it('rejects parent metadata whose identity differs from the requested session', () => {
    const replacement = rollout(OTHER);
    appendFileSync(
      replacement,
      item({ type: 'SubAgentActivity', agent_thread_id: CHILD, kind: 'started' }),
    );
    renameSync(replacement, parentFile);
    expect(listCodexSubagents(PARENT)).toEqual([]);
  });

  it('retries a partial UTF-8 record exactly once it is complete', () => {
    const record = Buffer.from(
      item({ type: 'AgentMessage', content: [{ type: 'Text', text: '正在检查' }] }),
    );
    const split = record.indexOf(Buffer.from('在')) + 1;
    appendFileSync(childFile, record.subarray(0, split));
    expect(listCodexSubagents(PARENT)[0]?.activity).toBeUndefined();
    appendFileSync(childFile, record.subarray(split));
    expect(listCodexSubagents(PARENT)[0]?.activity).toBe('正在检查');
    expect(listCodexSubagents(PARENT)).toHaveLength(1);
  });

  it('resets after truncation or replacing a rollout at the same path', () => {
    appendFileSync(childFile, event({ type: 'task_complete' }));
    expect(listCodexSubagents(PARENT)[0]?.done).toBe(true);
    rollout(CHILD, PARENT);
    expect(listCodexSubagents(PARENT)[0]?.done).toBe(false);
    const replacement = rollout(OTHER, PARENT);
    writeFileSync(replacement, readFileSync(replacement, 'utf8').replace(OTHER, CHILD));
    appendFileSync(replacement, event({ type: 'task_complete' }));
    renameSync(replacement, childFile);
    expect(listCodexSubagents(PARENT)[0]?.done).toBe(true);
  });

  it('does not stall forever on a record larger than the scan window', () => {
    appendFileSync(
      childFile,
      `${JSON.stringify({ type: 'ignored', data: 'x'.repeat(9 * 1024 * 1024) })}\n${event({ type: 'task_complete' })}`,
    );
    listCodexSubagents(PARENT);
    listCodexSubagents(PARENT);
    expect(listCodexSubagents(PARENT)[0]?.done).toBe(true);
  });
});

describe('SessionManager provider routing without live sessions', () => {
  it('routes Codex reads and never opens Claude task outputs for Codex', async () => {
    vi.mock('node-pty', () => ({
      spawn: vi.fn(() => {
        throw new Error('no live PTY allowed');
      }),
    }));
    const { SessionManager } = await import('../manager');
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      require: () => ({ node: { providerId: 'codex', cwd: '/fixture', claudeSessionId: PARENT } }),
    }) as InstanceType<typeof SessionManager>;
    expect(manager.subagents('session')).toMatchObject([{ agentId: CHILD }]);
    appendFileSync(
      childFile,
      item({ type: 'AgentMessage', content: [{ type: 'Text', text: 'ok' }] }),
    );
    expect(manager.subagentTranscript('session', CHILD)[0]?.text).toBe('ok');
    expect(manager.bgShells('session')).toEqual([]);
    expect(manager.bgShellOutput('session', 'task')).toMatchObject({ text: '', done: true });
  });
});
