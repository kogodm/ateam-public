import { describe, expect, it } from 'vitest';
import { codexPatch } from './codex-patch';
import { parseCodexBlocks } from './codex-transcript';

describe('Codex native patch events', () => {
  const changes = {
    'contracts.py': {
      type: 'update',
      unified_diff: '@@ -4,1 +4,2 @@\n-VERSION = 2\n+VERSION = 3\n+\n',
      move_path: null,
    },
    'overnight.py': {
      type: 'update',
      unified_diff: '@@ -53,1 +53,2 @@\n if endpoint_reference:\n+    validate()\n',
      move_path: null,
    },
  };
  it('preserves file names, hunk line numbers and signed changes', () => {
    expect(codexPatch(changes)).toEqual([
      {
        file: 'contracts.py',
        hunks: [{ oldStart: 4, newStart: 4, lines: ['-VERSION = 2', '+VERSION = 3', '+'] }],
      },
      {
        file: 'overnight.py',
        hunks: [
          { oldStart: 53, newStart: 53, lines: [' if endpoint_reference:', '+    validate()'] },
        ],
      },
    ]);
  });
  it('keeps a standalone native card even when exec response items are present', () => {
    const event = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-10-10T01:00:00Z',
      payload: { type: 'patch_apply_end', call_id: 'exec-child', success: true, changes },
    });
    const turns = parseCodexBlocks(event, 'session', 9, { toolSource: 'response_item' });
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      seq: 9,
      label: 'Edited 2 files',
      toolUseId: 'codex-patch:exec-child',
      kind: 'tool_use',
    });
    expect(turns[1]).toMatchObject({
      seq: 10,
      toolUseId: 'codex-patch:exec-child',
      kind: 'tool_result',
      patch: codexPatch(changes),
    });
  });
  it('does not present rejected or failed changes as applied', () => {
    const turns = parseCodexBlocks(
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'patch_apply_end',
          call_id: 'failed',
          success: false,
          changes,
          stderr: 'permission denied',
        },
      }),
      's',
      0,
    );
    expect(turns[0]?.label).toBe('File edit failed');
    expect(turns[1]?.patch).toBeUndefined();
    expect(turns[1]?.text).toBe('permission denied');
  });
  it('handles create, delete, rename and no-newline markers', () => {
    expect(
      codexPatch({
        'new.ts': { type: 'add', content: 'one\ntwo\n' },
        'old.ts': { type: 'delete', content: 'old\n' },
        'from.ts': {
          type: 'update',
          move_path: 'to.ts',
          unified_diff: '@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file',
        },
      }),
    ).toMatchObject([
      { file: 'new.ts', hunks: [{ lines: ['+one', '+two'] }] },
      { file: 'old.ts', hunks: [{ lines: ['-old'] }] },
      { file: 'to.ts', hunks: [{ lines: ['-a', '+b'] }] },
    ]);
  });
  it('bounds lines across files and rejects invalid changes', () => {
    const patch = codexPatch({
      first: { type: 'add', content: 'a\n'.repeat(399) },
      second: { type: 'add', content: 'b\n'.repeat(5) },
      bad: null,
    });
    expect(patch[0]?.hunks[0]?.lines).toHaveLength(399);
    expect(patch[1]).toMatchObject({ dropped: 4, hunks: [{ lines: ['+b'] }] });
    expect(codexPatch(null)).toEqual([]);
  });
});
