import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type HistoricalTurn,
  type ProjectedHistoricalTurn,
  projectHistoricalTools,
  redactHistoricalSecrets,
} from './historicalTools';

const turn = (text: string): HistoricalTurn => ({ seq: 12, role: 'user', text });

describe('projectHistoricalTools', () => {
  it('preserves the input kind union and extra fields in the exported result type', () => {
    type Input = HistoricalTurn & { kind?: 'text' | 'tool_use' | 'tool_result'; sessionId: string };
    const input: readonly Input[] = [
      { ...turn('plain'), kind: 'text', sessionId: 'fixture-session' },
    ];
    const output = projectHistoricalTools(input);
    expectTypeOf(output).toEqualTypeOf<Array<ProjectedHistoricalTurn<Input>>>();
    expectTypeOf(output[0]?.kind).toEqualTypeOf<Input['kind']>();
    expect(output[0]?.sessionId).toBe('fixture-session');
  });
  it('projects mixed prose and multiple markers with distinct ordered sequences', () => {
    const projected = projectHistoricalTools([
      turn(
        'Before\n\n[Historical tool call: Bash]\n{"command":"pwd","description":"Check directory"}\n\nAfter\n\n[Historical tool result: toolu_fixture]\n/workspace\n\n[Historical tool record: exec_command]\n{"cmd":"ls"}',
      ),
    ]);
    expect(projected.map((part) => part.text.trim())).toEqual([
      'Before',
      'pwd',
      'After',
      '/workspace',
      'ls',
    ]);
    expect(projected.map((part) => part.seq)).toEqual([12, 12.001, 12.002, 12.003, 12.004]);
    expect(projected[1]).toMatchObject({
      role: 'assistant',
      kind: 'tool_use',
      toolName: 'Bash',
      label: 'Check directory',
      historical: true,
    });
    expect(projected[3]).toMatchObject({
      role: 'tool',
      kind: 'tool_result',
      toolUseId: 'toolu_fixture',
      historical: true,
    });
    expect(projected[4]).toMatchObject({
      role: 'assistant',
      kind: 'tool_use',
      toolName: 'exec_command',
      historical: true,
    });
    expect(projected[0]?.historical).toBeUndefined();
    expect(projected[2]?.historical).toBeUndefined();
  });

  it.each(['```', '~~~', '````'])('ignores markers inside %s fences', (fence) => {
    const original = turn(
      `${fence}text\n\n[Historical tool call: Bash]\n{}\n${fence}\n\n[Historical tool call: Read]\n{"file_path":"/fixture.txt"}`,
    );
    const projected = projectHistoricalTools([original]);
    expect(projected).toHaveLength(2);
    expect(projected[0]?.text).toContain('[Historical tool call: Bash]');
    expect(projected[1]?.text).toBe('/fixture.txt');
  });

  it.each([
    'Inline [Historical tool call: Bash]\n{}',
    'Before\n[Historical tool call: Bash]\n{}',
    '\n[Historical tool call: Bash]\n{}',
    '[Historical tool call: Bash] trailing\n{}',
    '```\n\n[Historical tool result: toolu_fixture]\noutput',
  ])('leaves non-marker text unchanged: %s', (text) => {
    const original = turn(text);
    expect(projectHistoricalTools([original])[0]).toBe(original);
  });

  it('does not mutate inputs, ordinary prose, or native tool records', () => {
    const plain = Object.freeze(turn('API_KEY=fixture-plain'));
    const historical = Object.freeze(
      turn('[Historical tool call: Bash]\n{"command":"TOKEN=fixture-history pwd"}'),
    );
    const native = Object.freeze({ ...historical, kind: 'tool_use' });
    const result = Object.freeze({ ...historical, kind: 'tool_result' });
    const turns = Object.freeze([plain, historical, native, result]);
    const before = JSON.stringify(turns);
    const projected = projectHistoricalTools(turns);
    expect(JSON.stringify(turns)).toBe(before);
    expect(projected[0]).toBe(plain);
    expect(projected[1]?.text).toBe('TOKEN=[REDACTED] pwd');
    expect(projected[2]).toBe(native);
    expect(projected[3]).toBe(result);
  });

  it('decodes escaped newlines, quotes and braces in JSON commands', () => {
    const command = 'printf "{fixture}"\nprintf done';
    const [projected] = projectHistoricalTools([
      turn(`[Historical tool call: Bash]\n${JSON.stringify({ command })}`),
    ]);
    expect(projected?.text).toBe(command);
  });

  it.each(['cmd', 'file_path', 'path', 'filePath'])('extracts readable %s inputs', (key) => {
    expect(
      projectHistoricalTools([
        turn(`[Historical tool call: Read]\n${JSON.stringify({ [key]: '/fixture/path' })}`),
      ])[0]?.text,
    ).toBe('/fixture/path');
  });

  it('pretty prints other JSON objects and arrays', () => {
    for (const input of [{ nested: { count: 2 } }, ['fixture', 2]]) {
      expect(
        projectHistoricalTools([
          turn(`[Historical tool record: call_fixture]\n${JSON.stringify(input)}`),
        ])[0]?.text,
      ).toBe(JSON.stringify(input, null, 2));
    }
  });

  it('retains Write content alongside its readable file path', () => {
    const input = {
      file_path: '/fixture/write.ts',
      content: 'first line\nsecond line',
      description: 'Write fixture',
    };
    const [projected] = projectHistoricalTools([
      turn(`[Historical tool call: Write]\n${JSON.stringify(input)}`),
    ]);
    expect(projected?.text).toBe(
      `/fixture/write.ts\n\n${JSON.stringify({ content: input.content }, null, 2)}`,
    );
    expect(projected?.label).toBe('Write fixture');
  });

  it('retains Edit old/new strings and replacement options', () => {
    const input = {
      path: '/fixture/edit.ts',
      old_string: 'before\nline',
      new_string: 'after\nline',
      replace_all: true,
    };
    const [projected] = projectHistoricalTools([
      turn(`[Historical tool call: Edit]\n${JSON.stringify(input)}`),
    ]);
    expect(projected?.text).toBe(
      `/fixture/edit.ts\n\n${JSON.stringify({ old_string: input.old_string, new_string: input.new_string, replace_all: true }, null, 2)}`,
    );
  });

  it('retains additional command arguments without repeating the description', () => {
    const [projected] = projectHistoricalTools([
      turn('[Historical tool call: Bash]\n{"command":"pwd","timeout":1000,"description":"Check"}'),
    ]);
    expect(projected?.text).toBe('pwd\n\n{\n  "timeout": 1000\n}');
    expect(projected?.label).toBe('Check');
  });

  it('keeps malformed JSON as readable text and redacts its secrets', () => {
    const [projected] = projectHistoricalTools([
      turn('[Historical tool call: Bash]\n{"API_KEY":"fixture-broken", oops'),
    ]);
    expect(projected?.text).toBe('{"API_KEY":"[REDACTED]", oops');
    expect(projected?.kind).toBe('tool_use');
  });

  it('repairs result roles without guessing IDs for multiple calls', () => {
    const projected = projectHistoricalTools([
      turn(
        '[Historical tool call: Bash]\n{"cmd":"pwd"}\n\n[Historical tool call: Bash]\n{"cmd":"ls"}\n\n[Historical tool result: toolu_fixture]\noutput',
      ),
    ]);
    expect(projected[0]?.toolUseId).toBeUndefined();
    expect(projected[1]?.toolUseId).toBeUndefined();
    expect(projected[2]).toMatchObject({
      role: 'tool',
      kind: 'tool_result',
      toolUseId: 'toolu_fixture',
      text: 'output',
    });
  });

  it('handles CRLF and independent empty records', () => {
    const projected = projectHistoricalTools([
      turn(
        'Before\r\n\r\n[Historical tool record: call_fixture]\r\n\r\n[Historical tool result: toolu_fixture]',
      ),
    ]);
    expect(projected).toHaveLength(3);
    expect(projected[1]).toMatchObject({ text: '', kind: 'tool_use', historical: true });
    expect(projected[2]).toMatchObject({ text: '', kind: 'tool_result', historical: true });
  });

  it('redacts generated text and labels, but not adjacent ordinary prose', () => {
    const projected = projectHistoricalTools([
      turn(
        'TOKEN=fixture-prose\n\n[Historical tool call: Bash]\n{"command":"API_KEY=fixture-command pwd","description":"SECRET=fixture-label"}\n\nTOKEN=fixture-after',
      ),
    ]);
    expect(projected[0]?.text).toContain('TOKEN=fixture-prose');
    expect(projected[1]).toMatchObject({
      text: 'API_KEY=[REDACTED] pwd',
      label: 'SECRET=[REDACTED]',
    });
    expect(projected[2]?.text).toContain('TOKEN=fixture-after');
  });
});

describe('redactHistoricalSecrets', () => {
  it.each([
    ['API_KEY=fixture-a', 'API_KEY=[REDACTED]'],
    ['TOKEN=120', 'TOKEN=120'],
    ['{"token":120}', '{"token":120}'],
    ['GITHUB_TOKEN=123456', 'GITHUB_TOKEN=[REDACTED]'],
    ['TOKEN="123456"', 'TOKEN="[REDACTED]"'],
    ['export OPENAI_API_KEY="fixture with spaces"', 'export OPENAI_API_KEY="[REDACTED]"'],
    ["PASSWORD='fixture with spaces'", "PASSWORD='[REDACTED]'"],
    ['GITHUB_TOKEN=fixture-b; pwd', 'GITHUB_TOKEN=[REDACTED]; pwd'],
    ['CLIENT_SECRET = fixture-c', 'CLIENT_SECRET = [REDACTED]'],
    [
      '{"api_key":"fixture-d","refresh_token":"fixture-e"}',
      '{"api_key":"[REDACTED]","refresh_token":"[REDACTED]"}',
    ],
    ['{"password": "fixture\\"quoted"}', '{"password": "[REDACTED]"}'],
    ['Authorization: Bearer fixture-bearer', 'Authorization: Bearer [REDACTED]'],
    ['{"Authorization":"Bearer fixture-json"}', '{"Authorization":"Bearer [REDACTED]"}'],
  ])('redacts fixture assignment %s', (input, expected) => {
    expect(redactHistoricalSecrets(input)).toBe(expected);
  });

  it('does not remove ordinary token counts or prose', () => {
    const text =
      'token count: 120; 300 tokens; token_count=120; total_tokens=300; password policy; secret garden; API_KEY docs';
    expect(redactHistoricalSecrets(text)).toBe(text);
  });
});
