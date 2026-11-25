import { describe, expect, it } from 'vitest';
import { codexToolSource, parseCodexBlocks } from './codex-transcript';

const line = (item: Record<string, unknown>, timestamp = '2026-08-18T04:13:24.445Z'): string =>
  JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'item_completed', item } });

describe('codex rollout → Turn blocks', () => {
  it('reads a user message and an answer', () => {
    const u = parseCodexBlocks(
      line({ type: 'UserMessage', content: [{ type: 'text', text: '你好' }] }),
      's',
      0,
    );
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ role: 'user', kind: 'text', text: '你好', seq: 0 });
    const a = parseCodexBlocks(
      line({ type: 'AgentMessage', content: [{ type: 'Text', text: '回答' }] }),
      's',
      7,
    );
    expect(a[0]).toMatchObject({ role: 'assistant', kind: 'text', text: '回答', seq: 7 });
  });

  it('a command becomes a call and its result, with the shell wrapper stripped', () => {
    const t = parseCodexBlocks(
      line({
        type: 'CommandExecution',
        command: ['/bin/zsh', '-lc', 'ls -la'],
        aggregated_output: 'total 0',
        exit_code: 0,
      }),
      's',
      0,
    );
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ kind: 'tool_use', toolName: 'Bash', text: 'ls -la' });
    expect(t[1]).toMatchObject({ kind: 'tool_result', text: 'total 0' });
  });

  it('a non-zero exit is stated rather than left to be inferred', () => {
    const t = parseCodexBlocks(
      line({
        type: 'CommandExecution',
        command: ['/bin/zsh', '-lc', 'false'],
        aggregated_output: '',
        exit_code: 1,
      }),
      's',
      0,
    );
    expect(t.at(-1)?.text).toContain('[exit 1]');
  });

  it('a silent completed command still has a result, rather than looking pending forever', () => {
    const turns = parseCodexBlocks(
      line({
        type: 'CommandExecution',
        id: 'silent',
        command: ['true'],
        aggregated_output: '',
        exit_code: 0,
        status: 'completed',
      }),
      's',
      0,
    );
    expect(turns).toMatchObject([
      { kind: 'tool_use', toolUseId: 'silent' },
      { kind: 'tool_result', toolUseId: 'silent', text: '[exit 0]' },
    ]);
  });

  it('empty reasoning produces nothing — an empty thinking block is worse than none', () => {
    expect(
      parseCodexBlocks(line({ type: 'Reasoning', summary_text: [], raw_content: [] }), 's', 0),
    ).toEqual([]);
  });

  it('claude records and junk are ignored, not thrown on', () => {
    expect(
      parseCodexBlocks('{"type":"user","message":{"role":"user","content":"hi"}}', 's', 0),
    ).toEqual([]);
    expect(parseCodexBlocks('half a line {', 's', 0)).toEqual([]);
    expect(parseCodexBlocks('', 's', 0)).toEqual([]);
  });

  it('caps a huge block so one command cannot ship megabytes to a phone', () => {
    const t = parseCodexBlocks(
      line({
        type: 'CommandExecution',
        command: ['x'],
        aggregated_output: 'y'.repeat(50_000),
        exit_code: 0,
      }),
      's',
      0,
    );
    expect(t.at(-1)?.text.length).toBeLessThan(8100);
    expect(t.at(-1)?.text).toContain('truncated');
  });

  it('pairs command and MCP results by item id, not adjacency', () => {
    for (const item of [
      { type: 'CommandExecution', id: 'cmd-1', command: ['echo', 'ok'], aggregated_output: 'ok' },
      { type: 'McpToolCall', id: 'mcp-1', server: 'fixture', tool: 'read', result: 'ok' },
    ]) {
      const turns = parseCodexBlocks(line(item), 's', 0);
      expect(turns).toHaveLength(2);
      expect(turns.map((turn) => turn.toolUseId)).toEqual([item.id, item.id]);
    }
  });

  it('projects collaboration calls with a clickable agent id and paired result', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const turns = parseCodexBlocks(
      line({
        type: 'CollabAgentToolCall',
        id: 'spawn-1',
        tool: 'spawn_agent',
        prompt: 'Inspect fixture',
        status: 'completed',
        receiver_thread_ids: [id],
        agents_states: { [id]: 'pending_init' },
      }),
      's',
      3,
    );
    expect(turns).toMatchObject([
      {
        seq: 3,
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'spawn-1',
        text: 'Inspect fixture',
      },
      { seq: 4, kind: 'tool_result', toolUseId: 'spawn-1' },
    ]);
    expect(turns[1]?.text).toContain(`agentId: ${id}`);
  });

  it('uses the agent thread id when activity has a null path', () => {
    expect(
      parseCodexBlocks(
        line({
          type: 'SubAgentActivity',
          agent_thread_id: 'child',
          agent_path: null,
          kind: 'started',
        }),
        's',
        0,
      )[0]?.text,
    ).toBe('Agent child started');
  });
});

describe('codex turns that fail or stop', () => {
  const ev = (payload: Record<string, unknown>) =>
    JSON.stringify({ timestamp: '2026-09-14T09:48:50.345Z', type: 'event_msg', payload });

  it('reads legacy/native-import user_message and agent_message events', () => {
    expect(
      parseCodexBlocks(ev({ type: 'user_message', message: '真实提问', images: [] }), 's', 8),
    ).toMatchObject([
      {
        seq: 8,
        sessionId: 's',
        role: 'user',
        kind: 'text',
        text: '真实提问',
        at: '2026-09-14T09:48:50.345Z',
      },
    ]);
    expect(
      parseCodexBlocks(ev({ type: 'agent_message', message: '历史回答' }), 's', 9),
    ).toMatchObject([{ seq: 9, role: 'assistant', kind: 'text', text: '历史回答' }]);
  });

  it('does not double-count imported response_item history alongside visual events', () => {
    const records = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'question' }],
        },
      }),
      ev({ type: 'user_message', message: 'question' }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'answer' }],
        },
      }),
      ev({ type: 'agent_message', message: 'answer' }),
    ];
    const turns = records.flatMap((record) => parseCodexBlocks(record, 's', 0));
    expect(turns.map((turn) => turn.text)).toEqual(['question', 'answer']);
  });

  it('ignores empty/malformed legacy messages and caps imported text', () => {
    for (const message of ['', '  ', null, {}, []])
      expect(parseCodexBlocks(ev({ type: 'user_message', message }), 's', 0)).toEqual([]);
    const turns = parseCodexBlocks(
      ev({ type: 'agent_message', message: 'x'.repeat(20_000) }),
      's',
      0,
    );
    expect(turns[0]?.text.length).toBeLessThan(8100);
    expect(turns[0]?.text).toContain('truncated');
  });

  it('a failed turn shows its error — the API body reduced to status and message', () => {
    const t = parseCodexBlocks(
      ev({
        type: 'task_complete',
        last_agent_message: null,
        error: {
          message:
            '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'sonnet\' model is not supported when using Codex with a ChatGPT account."}}',
          codex_error_info: 'other',
        },
      }),
      's',
      0,
    );
    expect(t).toMatchObject([
      {
        role: 'assistant',
        kind: 'text',
        notice: 'error',
        text: "400 · The 'sonnet' model is not supported when using Codex with a ChatGPT account.",
      },
    ]);
    const limit = parseCodexBlocks(
      ev({
        type: 'task_complete',
        error: { message: "You've hit your usage limit. Upgrade to Pro" },
      }),
      's',
      0,
    );
    expect(limit[0]?.text).toBe("You've hit your usage limit. Upgrade to Pro");
  });

  it('a successful task_complete adds nothing; an interrupted turn says so', () => {
    expect(
      parseCodexBlocks(ev({ type: 'task_complete', last_agent_message: 'ok' }), 's', 0),
    ).toEqual([]);
    expect(
      parseCodexBlocks(ev({ type: 'turn_aborted', reason: 'interrupted' }), 's', 0),
    ).toMatchObject([{ notice: 'info', text: 'Interrupted' }]);
  });
});

describe('Codex response_item tool exchange', () => {
  const response = (payload: Record<string, unknown>) =>
    JSON.stringify({ timestamp: '2026-10-08T12:00:00Z', type: 'response_item', payload });
  const call = (name: string, args: unknown, callId = 'call-fixture') =>
    response({
      type: 'function_call',
      id: 'wire-message-id',
      name,
      arguments: JSON.stringify(args),
      call_id: callId,
    });

  it('projects a direct command before its result without executing it', () => {
    const turns = parseCodexBlocks(
      call('functions.exec_command', { cmd: 'printf fixture', yield_time_ms: 1000 }),
      'fixture',
      4,
    );
    expect(turns).toEqual([
      {
        seq: 4,
        sessionId: 'fixture',
        role: 'assistant',
        kind: 'tool_use',
        toolName: 'Bash',
        text: 'printf fixture',
        at: '2026-10-08T12:00:00Z',
        toolUseId: 'call-fixture',
      },
    ]);
    expect(
      parseCodexBlocks(
        response({ type: 'function_call_output', call_id: 'call-fixture', output: 'fixture' }),
        'fixture',
        5,
      ),
    ).toMatchObject([
      { seq: 5, role: 'tool', kind: 'tool_result', toolUseId: 'call-fixture', text: 'fixture' },
    ]);
  });

  it('preserves a multi-tool exec script as one call instead of guessing nested ownership', () => {
    const script =
      'const first = await tools.exec_command({cmd: "true"});\ntext(first);\nimage(await tools.view_image({path: "/fixture/idle_00.png"}));';
    const turns = parseCodexBlocks(
      response({
        type: 'custom_tool_call',
        id: 'message',
        status: 'completed',
        call_id: 'outer',
        name: 'exec',
        input: script,
      }),
      's',
      0,
    );
    expect(turns).toMatchObject([
      { kind: 'tool_use', toolName: 'exec', toolUseId: 'outer', text: script },
    ]);
    expect(turns).toHaveLength(1);
  });

  it('reads text parts in custom output and preserves printed running-cell/progress text', () => {
    const turns = parseCodexBlocks(
      response({
        type: 'custom_tool_call_output',
        id: 'different-message-id',
        call_id: 'outer',
        output: [
          { type: 'input_text', text: 'Script running with cell ID fixture-cell' },
          { type: 'input_text', text: '{"output":"进度 1/2","session_id":123}' },
        ],
      }),
      's',
      0,
    );
    expect(turns).toMatchObject([
      {
        toolUseId: 'outer',
        kind: 'tool_result',
        text: 'Script running with cell ID fixture-cell\n{"output":"进度 1/2","session_id":123}',
      },
    ]);
  });

  it.each([
    [
      'send_input',
      { id: 'fixture-child', message: 'Continue fixture' },
      'Sent input to fixture-child\nContinue fixture',
    ],
    [
      'wait',
      { ids: ['fixture-child', 'fixture-other'], timeout_ms: 10000 },
      'Waiting for fixture-child, fixture-other',
    ],
    [
      'wait',
      { cell_id: 'fixture-cell', yield_time_ms: 1000 },
      '{"cell_id":"fixture-cell","yield_time_ms":1000}',
    ],
    ['view_image', { path: '/fixture/idle_00.png' }, '/fixture/idle_00.png'],
    ['write_stdin', { session_id: 123, chars: '' }, '{"session_id":123,"chars":""}'],
  ])('keeps %s readable', (name, args, text) => {
    expect(parseCodexBlocks(call(name, args), 's', 0)).toMatchObject([
      { kind: 'tool_use', toolName: name, text },
    ]);
  });

  it('keeps the freeform patch readable', () => {
    const patch = '*** Begin Patch\n*** Add File: fixture.txt\n+fixture\n*** End Patch';
    expect(
      parseCodexBlocks(
        response({
          type: 'custom_tool_call',
          name: 'functions.apply_patch',
          input: patch,
          call_id: 'patch',
        }),
        's',
        0,
      ),
    ).toMatchObject([{ kind: 'tool_use', toolName: 'Edit', text: patch, toolUseId: 'patch' }]);
  });

  it.each([
    ['plain output', 'plain output'],
    [{ content: [{ type: 'text', text: 'structured text' }] }, 'structured text'],
    [{ status: 'idle', timed_out: true }, '{"status":"idle","timed_out":true}'],
    [
      [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      'first\nsecond',
    ],
    ['', '[completed]'],
    [[], '[completed]'],
    [null, '[completed]'],
  ])('projects output %j, including an empty terminal result', (output, text) => {
    for (const type of ['function_call_output', 'custom_tool_call_output'])
      expect(
        parseCodexBlocks(response({ type, call_id: 'fixture', output }), 's', 0),
      ).toMatchObject([{ kind: 'tool_result', role: 'tool', toolUseId: 'fixture', text }]);
  });

  it('pairs interleaved calls by call_id, never response id or adjacency', () => {
    const rows = [
      call('wait', { ids: ['child'] }, 'first'),
      call('view_image', { path: 'fixture.png' }, 'second'),
      response({
        type: 'function_call_output',
        id: 'other',
        call_id: 'first',
        output: 'No agents completed yet',
      }),
      response({ type: 'function_call_output', call_id: 'second', output: '' }),
    ];
    expect(
      rows.flatMap((row) => parseCodexBlocks(row, 's', 0)).map((turn) => turn.toolUseId),
    ).toEqual(['first', 'second', 'first', 'second']);
  });

  it('projects the verified ImageView visual schema with a finished card', () => {
    expect(
      parseCodexBlocks(
        line({ type: 'ImageView', id: 'image', path: '/fixture/idle_00.png' }),
        's',
        0,
      ),
    ).toMatchObject([
      {
        kind: 'tool_use',
        toolName: 'view_image',
        toolUseId: 'image',
        text: '/fixture/idle_00.png',
      },
      { kind: 'tool_result', toolUseId: 'image', text: '[completed]' },
    ]);
  });

  it('strips file:// so Stream can preview Codex Viewed image paths', () => {
    expect(
      parseCodexBlocks(
        line({
          type: 'ImageView',
          id: 'image',
          path: 'file:///Users/me/art/avatar-happy-comparison.jpg',
        }),
        's',
        0,
      ),
    ).toMatchObject([
      {
        kind: 'tool_use',
        toolName: 'view_image',
        text: '/Users/me/art/avatar-happy-comparison.jpg',
      },
      { kind: 'tool_result', text: '[completed]' },
    ]);
  });

  it('selects one tool source for a mixed rollout, independent of record order', () => {
    const rows = [
      line({ type: 'CommandExecution', id: 'command', command: ['true'], exit_code: 0 }),
      call('exec_command', { cmd: 'true' }, 'command'),
      response({ type: 'function_call_output', call_id: 'command', output: '' }),
      line({ type: 'ImageView', id: 'image', path: 'fixture.png' }),
      call('view_image', { path: 'fixture.png' }, 'image'),
      response({ type: 'function_call_output', call_id: 'image', output: '' }),
      line({
        type: 'CollabAgentToolCall',
        id: 'wait',
        tool: 'wait',
        receiver_thread_ids: ['child'],
        status: 'completed',
      }),
      call('wait', { ids: ['child'] }, 'wait'),
      response({
        type: 'function_call_output',
        call_id: 'wait',
        output: 'No agents completed yet',
      }),
    ];
    rows.push(
      line({ type: 'Extension', id: 'outer', kind: 'exec', durationMs: 12 }),
      line({ type: 'CommandExecution', id: 'nested-only', command: ['nested'], exit_code: 0 }),
    );
    for (const records of [rows, [...rows].reverse()]) {
      const options = { toolSource: codexToolSource(records) };
      expect(options.toolSource).toBe('response_item');
      const turns = records.flatMap((row) => parseCodexBlocks(row, 's', 0, options));
      expect(turns.filter((turn) => turn.kind === 'tool_use')).toHaveLength(3);
      expect(turns.filter((turn) => turn.kind === 'tool_result')).toHaveLength(3);
    }
    expect(codexToolSource(['bad', rows[0] as string])).toBe('event_msg');
    expect(parseCodexBlocks(rows[0] as string, 's', 0, { toolSource: 'event_msg' })).toHaveLength(
      2,
    );
    expect(parseCodexBlocks(rows[1] as string, 's', 0, { toolSource: 'event_msg' })).toEqual([]);
  });

  it('recognizes an output-only raw window without requiring its call in the same page', () => {
    const output = response({
      type: 'custom_tool_call_output',
      call_id: 'earlier-page',
      output: '',
    });
    const toolSource = codexToolSource([output]);
    expect(toolSource).toBe('response_item');
    expect(parseCodexBlocks(output, 's', 0, { toolSource })).toMatchObject([
      { kind: 'tool_result', toolUseId: 'earlier-page', text: '[completed]' },
    ]);
  });

  it('keeps visual text once while selecting raw tools', () => {
    const rows = [
      response({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }],
      }),
      line({ type: 'AgentMessage', content: [{ type: 'text', text: 'answer' }] }),
      call('wait', { ids: ['child'] }),
    ];
    const options = { toolSource: codexToolSource(rows) };
    expect(
      rows
        .flatMap((row) => parseCodexBlocks(row, 's', 0, options))
        .filter((turn) => turn.kind === 'text'),
    ).toMatchObject([{ text: 'answer' }]);
  });

  it('handles unknown tools, bad arguments, missing call ids and caps raw output', () => {
    expect(
      parseCodexBlocks(
        response({
          type: 'function_call',
          name: 'unknown',
          arguments: '{broken',
          call_id: 'bad-args',
        }),
        's',
        0,
      ),
    ).toMatchObject([{ toolName: 'unknown', text: '{broken' }]);
    expect(
      parseCodexBlocks(
        response({ type: 'function_call_output', id: 'not-a-call', output: 'ignored' }),
        's',
        0,
      ),
    ).toEqual([]);
    const turns = parseCodexBlocks(
      response({ type: 'function_call_output', call_id: 'huge', output: 'x'.repeat(50000) }),
      's',
      0,
    );
    expect(turns[0]?.text.length).toBeLessThan(8100);
    expect(turns[0]?.text).toContain('truncated');
  });
});
