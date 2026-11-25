import { describe, expect, it } from 'vitest';
import { atTokenAt, insertMention } from './atMention';

describe('atTokenAt', () => {
  it('finds the @ being typed at the caret', () => {
    expect(atTokenAt('look at @src/ap', 15)).toEqual({ start: 8, query: 'src/ap' });
    expect(atTokenAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(atTokenAt('看一下 @READ', 9)).toEqual({ start: 4, query: 'READ' });
  });
  it('not inside an address, nor once a space has ended it', () => {
    expect(atTokenAt('mail a@b.com', 12)).toBeNull();
    expect(atTokenAt('@src/app.ts done', 16)).toBeNull();
  });
  it('does not steal the second @ of a @@ human mention', () => {
    expect(atTokenAt('@@', 2)).toBeNull();
    expect(atTokenAt('ask @@Ali', 9)).toBeNull();
  });
  it('only what is before the caret counts', () => {
    expect(atTokenAt('@abc tail', 2)).toEqual({ start: 0, query: 'a' });
  });
});

describe('insertMention', () => {
  it('a file ends the mention with a space; a directory keeps it open', () => {
    const tok = { start: 8 };
    expect(insertMention('look at @ap and', 11, tok, 'src/app.ts')).toEqual({
      text: 'look at @src/app.ts  and',
      caret: 20,
    });
    expect(insertMention('look at @sr', 11, tok, 'src/')).toEqual({
      text: 'look at @src/',
      caret: 13,
    });
  });
});
