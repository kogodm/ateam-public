import { describe, expect, it } from 'vitest';
import { parseCodexBlocks } from './providers/codex-transcript';
import { parseTranscriptBlocks } from './transcript-file';

const claude = (name: string, input: unknown) => {
  const turn = parseTranscriptBlocks(
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
    }),
    's',
    0,
  )[0];
  if (!turn) throw new Error(`No turn parsed for ${name}`);
  return turn;
};
describe('peer tool turns match native Claude tools', () => {
  it.each([
    ['send_message', 'SendMessage', { to: 'Coder', message: 'hello', summary: 'check this' }],
    ['list_sessions', 'ListAgents', {}],
  ] as const)('%s', (tool, native, args) => {
    const expected = claude(native, args);
    expect(claude(`mcp__ateam-peers__${tool}`, args)).toEqual(expected);
    const turns = parseCodexBlocks(
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'McpToolCall',
            server: 'ateam_peers',
            tool,
            arguments: args,
            result: 'done',
          },
        },
      }),
      's',
      0,
    );
    expect(turns[0]).toMatchObject({
      toolName: native,
      text: expected.text,
      role: expected.role,
      kind: 'tool_use',
    });
    expect(turns[1]).toMatchObject({ kind: 'tool_result', text: 'done' });
  });
  it.each([
    ['send_message', 'SendMessage', { to: 'Coder', message: 'hi' }],
    ['list_sessions', 'ListAgents', {}],
  ] as const)('normalizes Codex response-item %s too', (tool, native, args) => {
    const expected = claude(native, args);
    const turns = parseCodexBlocks(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call',
          name: `mcp__ateam_peers__${tool}`,
          arguments: JSON.stringify(args),
        },
      }),
      's',
      0,
    );
    expect(turns[0]).toMatchObject({ toolName: native, role: expected.role, text: expected.text });
  });
});
