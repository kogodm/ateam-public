import { describe, expect, it } from 'vitest';
import { codexResponseCallIds, parseCodexBlocks } from './codex-transcript';

const event = (payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: '2026-10-10T00:00:00Z', type: 'event_msg', payload });
const item = (value: Record<string, unknown>) => event({ type: 'item_completed', item: value });
const parse = (line: string) =>
  parseCodexBlocks(line, 'session', 0, { responseCallIds: new Set(), toolSource: 'response_item' });

describe('Codex persisted event coverage', () => {
  it('uses CLI parsed command names and retains stderr beside stdout', () => {
    const turns = parse(
      item({
        type: 'CommandExecution',
        id: 'read',
        command: ['cat', 'src/file.ts'],
        parsed_cmd: [{ type: 'read', name: 'src/file.ts', path: 'src/file.ts' }],
        stdout: 'partial',
        stderr: 'failed read',
        exit_code: 1,
      }),
    );
    expect(turns[0]?.label).toBe('Read file.ts');
    expect(turns[1]?.text).toBe('[exit 1]\npartial\nfailed read');
  });
  it('retains standalone web.search extension results', () => {
    expect(
      parse(
        item({
          type: 'Extension',
          kind: 'web.search',
          id: 'search-ext',
          query: 'fixture',
          results: [{ title: 'Found result' }],
        }),
      )[1]?.text,
    ).toContain('Found result');
  });
  it('shows compaction as a visible notice rather than filtered system text', () => {
    expect(parse(event({ type: 'context_compacted' }))).toMatchObject([
      { role: 'assistant', notice: 'info', text: 'Context compacted' },
    ]);
    expect(parse(item({ type: 'ContextCompaction' }))).toMatchObject([{ notice: 'info' }]);
  });
  it('reads legacy summaries and string-array reasoning without encrypted payloads', () => {
    expect(parse(event({ type: 'agent_reasoning', text: 'Public summary' }))[0]).toMatchObject({
      text: 'Public summary',
      kind: 'thinking',
    });
    expect(parse(item({ type: 'Reasoning', summary_text: ['First', 'Second'] }))[0]?.text).toBe(
      'First\nSecond',
    );
    expect(
      parseCodexBlocks(
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'reasoning', encrypted_content: 'secret' },
        }),
        's',
        0,
      ),
    ).toEqual([]);
  });
  it('keeps image-only user turns without echoing base64', () => {
    expect(
      parse(
        event({ type: 'user_message', message: '', images: ['data:image/png;base64,secret'] }),
      )[0]?.text,
    ).toBe('[Image attached]');
    expect(
      parse(
        item({
          type: 'UserMessage',
          content: [{ type: 'image', image_url: 'data:image/png;base64,secret' }],
        }),
      )[0]?.text,
    ).toBe('[Attachment]');
  });
  it('renders turn_complete errors but does not duplicate final text', () => {
    expect(
      parse(event({ type: 'turn_complete', error: { message: 'Failed request' } }))[0],
    ).toMatchObject({ notice: 'error', text: 'Failed request' });
    expect(parse(event({ type: 'turn_complete', last_agent_message: 'Already shown' }))).toEqual(
      [],
    );
  });
  it('renders native web search query and results as a paired tool', () => {
    const turns = parse(
      event({
        type: 'web_search_end',
        call_id: 'search',
        query: 'fixture query',
        results: [{ title: 'Result', url: 'https://example.com' }],
      }),
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      toolUseId: 'search',
      toolName: 'WebSearch',
      text: 'fixture query',
    });
    expect(turns[1]?.toolUseId).toBe('search');
    expect(turns[1]?.text).toContain('Result');
  });
  it('unwraps MCP success and error variants and protects image payloads', () => {
    const base = {
      type: 'mcp_tool_call_end',
      call_id: 'mcp',
      invocation: { server: 'fixture', tool: 'read', arguments: { file: 'a' } },
    };
    expect(
      parse(
        event({
          ...base,
          result: {
            Ok: {
              content: [
                { type: 'text', text: 'Actual output' },
                { type: 'image', data: 'secret-base64' },
              ],
            },
          },
        }),
      )[1]?.text,
    ).toBe('Actual output\n[Image]');
    expect(parse(event({ ...base, result: { Err: 'Server failed' } }))[1]?.text).toBe(
      'Error: Server failed',
    );
  });
  it('does not print generated image base64 as text', () => {
    const turns = parse(
      event({
        type: 'image_generation_end',
        call_id: 'image',
        status: 'completed',
        saved_path: '/tmp/output.png',
        result: 'secret-base64',
      }),
    );
    expect(turns[1]?.text).toBe('/tmp/output.png');
    expect(JSON.stringify(turns)).not.toContain('secret-base64');
  });
  it('keeps standalone output items and deduplicates only matching response ids', () => {
    const line = item({
      type: 'FunctionCallOutput',
      id: 'nested',
      name: 'read',
      output: [{ type: 'input_text', text: 'nested output' }],
    });
    expect(parse(line)[0]).toMatchObject({
      toolUseId: 'nested',
      kind: 'tool_result',
      text: 'nested output',
    });
    expect(parseCodexBlocks(line, 's', 0, { responseOutputIds: new Set(['nested']) })).toEqual([]);
    expect(parseCodexBlocks(line, 's', 0, { responseCallIds: new Set(['nested']) })).toHaveLength(
      1,
    );
  });
  it('keeps an independent native command beside an exec wrapper', () => {
    const raw = JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', call_id: 'outer', input: '' },
    });
    const ids = codexResponseCallIds([raw, 'invalid']);
    expect(ids).toEqual(new Set(['outer']));
    const command = item({
      type: 'CommandExecution',
      id: 'nested',
      command: ['echo', 'ok'],
      aggregated_output: 'ok',
      exit_code: 0,
    });
    expect(
      parseCodexBlocks(command, 's', 0, { responseCallIds: ids, toolSource: 'response_item' }),
    ).toHaveLength(2);
    expect(
      parseCodexBlocks(command, 's', 0, {
        responseCallIds: new Set(['nested']),
        toolSource: 'response_item',
      }),
    ).toEqual([]);
  });
  it('shows plans, sleep completion and sub-agent activity', () => {
    expect(parse(item({ type: 'Plan', text: '1. Verify\n2. Fix' }))[0]?.text).toContain('Verify');
    expect(
      parse(item({ type: 'Extension', kind: 'clock.sleep', id: 'sleep', durationMs: 1000 })),
    ).toMatchObject([{ text: 'Wait 1000 ms', kind: 'tool_use' }, { kind: 'tool_result' }]);
    expect(
      parse(event({ type: 'sub_agent_activity', agent_thread_id: 'child', kind: 'completed' }))[0],
    ).toMatchObject({ notice: 'info', text: 'Agent child completed' });
  });
  it('renders failed dynamic calls without marking them successful', () => {
    expect(
      parse(
        item({
          type: 'DynamicToolCall',
          id: 'dynamic',
          tool: 'fixture',
          arguments: {},
          status: 'failed',
          error: 'Denied',
        }),
      )[1]?.text,
    ).toBe('Denied');
  });
  it('preserves rich FileChange items with status and real diff', () => {
    const changes = { 'a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n' } };
    expect(
      parse(item({ type: 'FileChange', id: 'patch', changes, status: 'completed' }))[1]?.patch,
    ).toHaveLength(1);
    expect(
      parse(
        item({ type: 'FileChange', id: 'patch', changes, status: 'failed', stderr: 'Failed' }),
      )[1]?.patch,
    ).toBeUndefined();
  });
  it('keeps protocol bookkeeping silent', () => {
    for (const type of ['token_count', 'task_started', 'turn_started', 'thread_settings_applied'])
      expect(parse(event({ type }))).toEqual([]);
  });
});
