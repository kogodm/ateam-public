import { describe, expect, it } from 'vitest';
import { splitQueue } from './queueTray';

const enq = (text: string) => ({ text, queued: true });
const deq = () => ({ text: '', dequeued: true });
const rem = (text: string) => ({ text, dequeued: true });
const msg = (text: string) => ({ text });

const texts = (r: ReturnType<typeof splitQueue>) => ({
  conversation: r.conversation.map((t) => t.text),
  tray: r.tray.map((t) => t.text),
});

describe('splitQueue', () => {
  it('queued messages wait in the tray, not in the conversation', () => {
    expect(texts(splitQueue([msg('hi'), enq('a'), msg('reply'), enq('b')]))).toEqual({
      conversation: ['hi', 'reply'],
      tray: ['a', 'b'],
    });
  });

  it('a dequeue takes the oldest; the user record after it is the message', () => {
    expect(texts(splitQueue([enq('a'), enq('b'), deq(), msg('a'), msg('answer')]))).toEqual({
      conversation: ['a', 'answer'],
      tray: ['b'],
    });
  });

  it('a remove takes the named one; the attachment after it is the message', () => {
    expect(texts(splitQueue([enq('a'), enq('b'), rem('b '), msg('b')]))).toEqual({
      conversation: ['b'],
      tray: ['a'],
    });
  });

  it('keeps a mid-turn injected turn in the conversation while consuming its queued copy', () => {
    const injected = {
      text: 'please update the title',
      role: 'user',
      injected: 'mid_turn' as const,
    };
    const result = splitQueue([enq(injected.text), rem(injected.text), injected]);
    expect(result.tray).toEqual([]);
    expect(result.conversation).toEqual([injected]);
  });

  it('pulled back for editing, then re-queued edited: only the edit waits', () => {
    // popAll records parse to the same marker as remove
    expect(texts(splitQueue([enq('a'), enq('b'), rem('a'), rem('b'), enq('a+b edited')]))).toEqual({
      conversation: [],
      tray: ['a+b edited'],
    });
  });

  it('an orphan left at the head of the line does not make the tray run behind (09-23)', () => {
    // a session that exited with these still queued wrote no record for them;
    // taking "the oldest" on each dequeue removed an orphan instead, and the
    // message claude had already answered stayed in the tray
    expect(
      texts(
        splitQueue([
          enq('<agent-message from="x">old</agent-message>'),
          enq('<task-notification>old</task-notification>'),
          enq('我的计划是 推荐改变玩家看到的排序'),
          deq(),
          msg('我的计划是 推荐改变玩家看到的排序'),
        ]),
      ).tray,
    ).toEqual([
      '<agent-message from="x">old</agent-message>',
      '<task-notification>old</task-notification>',
    ]);
  });

  it('an injected message is taken up wrapped, and still leaves the tray', () => {
    const x = '<cross-session-message from="a">hi</cross-session-message>';
    expect(
      texts(splitQueue([enq(x), deq(), msg(`Another Claude session sent a message:\n${x}`)])).tray,
    ).toEqual([]);
  });

  it('pairs an injected message whose tag was rewritten on the way in', () => {
    // queued with a hop-chain attribute the delivered record no longer has
    expect(
      texts(
        splitQueue([
          enq('orphan'),
          enq(
            '<cross-session-message from="a" hop-chain="1,2" from-name="n">数据已交付</cross-session-message>',
          ),
          deq(),
          msg(
            'Another Claude session sent a message:\n<cross-session-message from="a" from-name="n">数据已交付</cross-session-message>',
          ),
        ]),
      ).tray,
    ).toEqual(['orphan']);
  });

  it('assistant output between a dequeue and its record does not pair with it', () => {
    const r = splitQueue([
      enq('orphan'),
      enq('b'),
      deq(),
      { text: 'thinking…', role: 'assistant' },
      { text: 'b', role: 'user' },
    ]);
    expect(texts(r).tray).toEqual(['orphan']);
  });

  it('a dequeue with nothing queued (its enqueue was before the loaded window) is harmless', () => {
    expect(texts(splitQueue([deq(), msg('x')]))).toEqual({ conversation: ['x'], tray: [] });
  });
});
