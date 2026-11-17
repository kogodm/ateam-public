import { describe, expect, it } from 'vitest';
import { queuedCarryoverBlock, unhandledQueuedMessages } from './queued-carryover';

const q = (operation: string, content?: string): string =>
  JSON.stringify({ type: 'queue-operation', operation, timestamp: 't', content });

describe('unhandledQueuedMessages', () => {
  it('dequeue takes the oldest, remove takes the named one', () => {
    const lines = [
      q('enqueue', 'first'),
      q('enqueue', 'second'),
      q('enqueue', 'third'),
      q('dequeue'),
      q('remove', 'third'),
    ];
    expect(unhandledQueuedMessages(lines)).toEqual(['second']);
  });

  it('the 2026-09-14 handoff: the handoff prompt jumps the queue, the user messages stay', () => {
    const lines = [
      q('enqueue', '<task-notification>\n<task-id>b1</task-id>'),
      q('remove', '<task-notification>\n<task-id>b1</task-id>'),
      q('enqueue', 'stream模式下 这种打断的bash执行 合并成一条展示'),
      q('enqueue', '思考的显示等级可以再高一点点'),
      q('enqueue', '<task-notification>\n<task-id>b2</task-id>'),
      q('enqueue', '[Ateam auto-handoff — context approaching the configured threshold]'),
      q('remove', '[Ateam auto-handoff — context approaching the configured threshold]'),
      '{"type":"assistant","message":{"role":"assistant","content":[]}}',
    ];
    expect(unhandledQueuedMessages(lines)).toEqual([
      'stream模式下 这种打断的bash执行 合并成一条展示',
      '思考的显示等级可以再高一点点',
    ]);
  });

  it('messages pulled back for editing (popAll) leave the queue; the edit re-enqueues', () => {
    const lines = [
      q('enqueue', 'one'),
      q('enqueue', 'two'),
      q('popAll', 'one'),
      q('popAll', 'two'),
      q('enqueue', 'one, edited'),
    ];
    expect(unhandledQueuedMessages(lines)).toEqual(['one, edited']);
  });

  it('ignores torn lines and a dequeue on an empty queue', () => {
    expect(
      unhandledQueuedMessages([q('dequeue'), '{"type":"queue-oper', q('enqueue', 'x')]),
    ).toEqual(['x']);
  });

  it('builds nothing for no messages, a numbered block otherwise', () => {
    expect(queuedCarryoverBlock([])).toBe('');
    const b = queuedCarryoverBlock(['a', 'b']);
    expect(b).toContain('--- QUEUED MESSAGES ---');
    expect(b).toContain('[1]\na');
    expect(b).toContain('[2]\nb');
  });
});
