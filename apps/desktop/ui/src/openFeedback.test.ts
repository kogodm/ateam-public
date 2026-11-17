import { describe, expect, it } from 'vitest';
import { cantFindMessage, openFailedMessage } from './openFeedback';

describe('cantFindMessage', () => {
  it('lists where a relative path was looked for', () => {
    expect(cantFindMessage('docs/a.md', ['/p/docs/a.md', '/q/docs/a.md', '/r/docs/a.md'])).toBe(
      "can't find docs/a.md (looked in 3 places: /p/docs/a.md, /q/docs/a.md…)",
    );
    expect(cantFindMessage('docs/a.md', ['/p/docs/a.md'])).toBe(
      "can't find docs/a.md (looked in 1 place: /p/docs/a.md)",
    );
  });
  it('does not repeat an absolute path back as the place it was looked for', () => {
    expect(cantFindMessage('/gone/file.md', ['/gone/file.md'])).toBe("can't find /gone/file.md");
    expect(cantFindMessage('~/gone.md', ['/Users/me/gone.md'])).toBe("can't find ~/gone.md");
  });
  it('says just that when nothing was tried', () => {
    expect(cantFindMessage('x.md', [])).toBe("can't find x.md");
  });
});

describe('openFailedMessage', () => {
  it('carries the reason, whatever shape it arrives in', () => {
    expect(openFailedMessage('/a.zip', 'no app')).toBe("can't open /a.zip: no app");
    expect(openFailedMessage('/a.zip', new Error('denied'))).toBe("can't open /a.zip: denied");
    expect(openFailedMessage('/a.zip', undefined)).toBe("can't open /a.zip: unknown error");
  });
});
