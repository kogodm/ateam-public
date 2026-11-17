import { describe, expect, it } from 'vitest';
import { composePayload, messageBody, sameMessage } from './composePayload';

describe('composePayload', () => {
  it('never starts with a path — claude would hold it back as a slash command', () => {
    const p = '/Users/me/.ateam/uploads/x.png';
    expect(composePayload('is this a duplicate?', [p])).toBe(`is this a duplicate? ${p}`);
    expect(composePayload('', [p])).toBe(`Attached: ${p}`);
    expect(composePayload('', [p]).trim().startsWith('/')).toBe(false);
    expect(composePayload('hello', [])).toBe('hello');
    expect(composePayload('', [])).toBe('');
  });
});

describe('messageBody', () => {
  it('a sent picture message matches the record claude writes for it (09-15)', () => {
    const p = '/Users/me/.ateam/uploads/20260915-x-QQ.png';
    const sent = composePayload('好像占的太多了  每个只显示一行吧', [p]);
    expect(messageBody(sent)).toBe(messageBody('[Image #2]好像占的太多了  每个只显示一行吧'));
    expect(messageBody(composePayload('', [p]))).toBe(messageBody('[Image #3]'));
    expect(messageBody('/Users/me/.ateam-debug/uploads/a.jpg hi')).toBe('hi');
  });
  it('different words stay different', () => {
    expect(messageBody('[Image #1]one')).not.toBe(messageBody('two'));
  });
});

describe('sameMessage', () => {
  it('pairs a record with what was sent', () => {
    expect(sameMessage('look /u/.ateam/uploads/a.png', '[Image #2]look')).toBe(true);
  });
  it('pairs a record that carries text left in the input box before it (09-23)', () => {
    // after a restart claude puts its unanswered last message back in the box,
    // and the stream types the next one after it
    expect(
      sameMessage(
        '卡这里了 /Users/m/.ateam/uploads/20260923-x.png',
        'stream模式不显示模型了卡这里了 /Users/m/.ateam/uploads/20260923-x.png',
      ),
    ).toBe(true);
  });
  it('does not pair different words', () => {
    expect(sameMessage('卡这里了', '卡这里了吗？')).toBe(false);
    expect(sameMessage('', 'anything')).toBe(false);
  });
});
