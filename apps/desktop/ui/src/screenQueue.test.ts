import { describe, expect, it, vi } from 'vitest';
import { sameMessage } from './composePayload';
import {
  type QueuePending,
  confirmedScreenPending,
  expireQueuePending,
  rememberScreenQueued,
  screenQueue,
  screenQueuedIds,
} from './screenQueue';

const header =
  '• Messages to be submitted after next tool call (press esc to interrupt and send immediately)';
const first = '优先使用版本高的codex cli （如果都存在的话）';
const second =
  'codex 不属于本session的agent也显示到本session来了 /Users/sample/.ateam/uploads/20261009-qq.png';
const screenshot = [header, `  ↳ ${first}`, `  ↳ ${second}`];

const pendingMessage = (id: number, text: string): QueuePending => ({ id, text, userTurns: 0 });

describe('Codex pending queue pairing', () => {
  it('allows transcript image/suffix matching without broadening screen matching', () => {
    const pending = [
      pendingMessage(1, '看图 /Users/sample/.ateam/uploads/a.png'),
      pendingMessage(2, '看图 /Users/sample/.ateam/uploads/a.png'),
    ];
    expect(screenQueuedIds(pending, ['[Image #1]看图']).size).toBe(0);
    expect(confirmedScreenPending(pending, '[Image #1]看图')).toBeUndefined();
    const confirmed = confirmedScreenPending(pending, '[Image #1]看图', sameMessage);
    expect(confirmed?.id).toBe(1);
    expect(
      pending.filter((message) => message.id !== confirmed?.id).map((message) => message.id),
    ).toEqual([2]);
    expect(confirmedScreenPending(pending, '旧输入 看图', sameMessage)?.id).toBe(1);
  });
  it('normalizes whitespace and consumes repeated queue entries one at a time', () => {
    const pending = [pendingMessage(1, '中文  消息'), pendingMessage(2, '中文 消息')];
    expect([...screenQueuedIds(pending, [' 中文\n消息 '])]).toEqual([1]);
    expect([...screenQueuedIds(pending, ['中文 消息', '中文 消息'])]).toEqual([1, 2]);
    const marked = rememberScreenQueued(pending, ['中文 消息']);
    expect(marked).toHaveLength(2);
    expect(marked[0]).toMatchObject({ queued: true, stale: false });
    expect(marked[1]).not.toHaveProperty('queued');
  });

  it('keeps complete attachment paths in the comparison', () => {
    const secondPayload = '看图 /Users/sample/.ateam/uploads/b.png';
    const pending = [
      pendingMessage(1, '看图 /Users/sample/.ateam/uploads/a.png'),
      pendingMessage(2, secondPayload),
    ];
    expect([...screenQueuedIds(pending, [secondPayload])]).toEqual([2]);
    expect(screenQueuedIds(pending, ['看图 [Image #1]']).size).toBe(0);
    expect(confirmedScreenPending(pending, secondPayload)?.id).toBe(2);
    expect(confirmedScreenPending(pending, '看图 [Image #1]')).toBeUndefined();
  });

  it('does not guess from truncated, prefixed, suffixed or missing screen text', () => {
    const pending = [pendingMessage(1, '完整中文消息 /tmp/image.png')];
    for (const queue of [
      [],
      ['完整中文消息…'],
      ['完整中文消息'],
      ['prefix 完整中文消息 /tmp/image.png'],
    ]) {
      expect(screenQueuedIds(pending, queue).size).toBe(0);
      expect(rememberScreenQueued(pending, queue)).toBe(pending);
    }
    expect(confirmedScreenPending(pending, 'prefix 完整中文消息 /tmp/image.png')).toBeUndefined();
  });

  it('keeps sticky evidence after dequeue without hiding the awaiting-confirmation message', () => {
    const marked = rememberScreenQueued([pendingMessage(1, '排队')], ['排队']);
    expect(screenQueuedIds(marked, ['排队']).has(1)).toBe(true);
    const dequeued = rememberScreenQueued(marked, []);
    expect(dequeued).toBe(marked);
    expect(dequeued[0]?.queued).toBe(true);
    expect(screenQueuedIds(dequeued, []).size).toBe(0);
    expect(dequeued.flatMap((message) => expireQueuePending(message, 'codex', 100))).toMatchObject([
      { queued: true, stale: false },
    ]);
  });

  it('survives long waits and unrelated user records, including after leaving the screen', () => {
    vi.useFakeTimers();
    try {
      let pending = rememberScreenQueued([pendingMessage(1, '长等待')], ['长等待']);
      setTimeout(() => {
        pending = pending.flatMap((message) => expireQueuePending(message, 'codex', 10));
      }, 60_000);
      pending = rememberScreenQueued(pending, []);
      vi.advanceTimersByTime(600_000);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ queued: true, stale: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('repairs stale state when queue evidence arrives later and protects queued slash input', () => {
    const marked = rememberScreenQueued(
      [{ ...pendingMessage(1, '/queued'), stale: true }],
      ['/queued'],
    );
    expect(marked.flatMap((message) => expireQueuePending(message, 'codex', 10))).toEqual(marked);
    expect(marked[0]?.stale).toBe(false);
  });

  it('confirms only the first exact pending twin per user record', () => {
    let pending = [pendingMessage(1, '重复'), pendingMessage(2, '重复')];
    const confirmed = confirmedScreenPending(pending, ' 重复 ');
    pending = pending.filter((message) => message.id !== confirmed?.id);
    expect(pending.map((message) => message.id)).toEqual([2]);
    expect(confirmedScreenPending(pending, '其他记录')).toBeUndefined();
    expect(confirmedScreenPending(pending, '重复')?.id).toBe(2);
  });

  it('does not delete unconfirmed Codex text on unrelated records and preserves Claude expiry', () => {
    const message = pendingMessage(1, '未确认');
    expect(expireQueuePending(message, 'codex', 10)).toEqual([{ ...message, stale: true }]);
    expect(expireQueuePending(message, 'claude', 10)).toEqual([]);
    expect(expireQueuePending(message, 'claude', 0)).toEqual([{ ...message, stale: true }]);
    expect(expireQueuePending(pendingMessage(2, '/model'), 'codex', 0)).toEqual([]);
  });
});

describe('screenQueue', () => {
  it('reads both Chinese messages and their path from the reported screen', () => {
    expect(screenQueue(screenshot, 'codex')).toEqual([first, second]);
  });

  it('does not read a Codex queue for other or unknown providers', () => {
    for (const provider of ['claude', 'opencode', undefined] as const) {
      expect(screenQueue(screenshot, provider)).toEqual([]);
    }
  });

  it('requires the queue header, not merely arrows in tool or assistant output', () => {
    expect(screenQueue(['  ↳ quoted message'], 'codex')).toEqual([]);
    expect(screenQueue([`Quoted: ${header}`, '  ↳ not queued'], 'codex')).toEqual([]);
  });

  it('preserves indented continuation rows and stops before the composer', () => {
    expect(
      screenQueue(
        [
          header,
          '  ↳ 很长的消息',
          '    接着显示路径 /tmp/a.png',
          '  ↳ 第二条',
          '› draft',
          '  ↳ not queued',
        ],
        'codex',
      ),
    ).toEqual(['很长的消息\n接着显示路径 /tmp/a.png', '第二条']);
  });

  it('accepts a separately wrapped interrupt hint', () => {
    expect(
      screenQueue(
        [
          '• Messages to be submitted after next tool call',
          '  (press esc to interrupt and send immediately)',
          '  ↳ queued',
        ],
        'codex',
      ),
    ).toEqual(['queued']);
  });

  it('accepts narrow screens wrapping both the title and interrupt hint', () => {
    expect(
      screenQueue(
        [
          '• Messages to be submitted after',
          '  next tool call (press esc to interrupt',
          '  and send immediately)',
          '  ↳ 中文消息',
        ],
        'codex',
      ),
    ).toEqual(['中文消息']);
  });

  it('stops at blank lines, borders and unindented output', () => {
    for (const boundary of ['', '    ─────────', 'assistant output']) {
      expect(screenQueue([header, '  ↳ queued', boundary, '  ↳ not queued'], 'codex')).toEqual([
        'queued',
      ]);
    }
  });

  it('keeps repeated messages as separate ordered items', () => {
    expect(screenQueue([header, '  ↳ 重复', '  ↳ 重复'], 'codex')).toEqual(['重复', '重复']);
  });

  it('uses the last queue block and clears when it disappears on the next screen', () => {
    expect(screenQueue([...screenshot, '', header, '  ↳ remaining'], 'codex')).toEqual([
      'remaining',
    ]);
    expect(screenQueue(['› ', '100% context left'], 'codex')).toEqual([]);
    expect(screenQueue([], 'codex')).toEqual([]);
  });

  it('does not absorb the interrupt hint or an empty item as a message', () => {
    expect(screenQueue([header], 'codex')).toEqual([]);
    expect(screenQueue([header, '  ↳ '], 'codex')).toEqual([]);
  });
});
