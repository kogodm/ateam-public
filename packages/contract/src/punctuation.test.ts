import { describe, expect, it } from 'vitest';
import { asciiPunctuation, asciiPunctuationAt } from './punctuation';

describe('asciiPunctuation', () => {
  it('rewrites common Chinese marks to ASCII', () => {
    expect(asciiPunctuation('你好，世界。')).toBe('你好,世界.');
    expect(asciiPunctuation('试试：【啊】（嗯）？！')).toBe('试试:[啊](嗯)?!');
    expect(asciiPunctuation('「引」『号』')).toBe('"引""号"');
    expect(asciiPunctuation('（括号）')).toBe('(括号)');
    expect(asciiPunctuation('｟白｠')).toBe('(白)');
  });

  it('rewrites fullwidth ASCII letters and digits', () => {
    expect(asciiPunctuation('ａｂｃ１２３')).toBe('abc123');
  });

  it('expands ellipsis and em dash', () => {
    expect(asciiPunctuation('……——')).toBe('...--');
  });

  it('leaves control sequences and Latin alone', () => {
    expect(asciiPunctuation('\x1b[200~hi\x1b[201~')).toBe('\x1b[200~hi\x1b[201~');
    expect(asciiPunctuation('hello, world.')).toBe('hello, world.');
  });

  it('is idempotent', () => {
    const once = asciiPunctuation('中文，标点：【测】');
    expect(asciiPunctuation(once)).toBe(once);
  });
});

describe('asciiPunctuationAt', () => {
  it('keeps the caret when a mark stays one character', () => {
    const { text, caret } = asciiPunctuationAt('啊，', 2);
    expect(text).toBe('啊,');
    expect(caret).toBe(2);
  });

  it('moves the caret when a mark expands', () => {
    const { text, caret } = asciiPunctuationAt('啊…', 2);
    expect(text).toBe('啊...');
    expect(caret).toBe(4);
  });
});
