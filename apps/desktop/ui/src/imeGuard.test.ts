import { describe, expect, it } from 'vitest';
import { IME_COMMIT_GRACE_MS, enterIsImeCommit } from './imeGuard';

const base = {
  composing: false,
  sinceCompositionEnd: Number.POSITIVE_INFINITY,
  isComposing: false,
  keyCode: 13,
};

describe('telling an IME commit from a real send', () => {
  it('a plain Enter sends', () => {
    expect(enterIsImeCommit(base)).toBe(false);
  });

  it('Enter while a composition is open is a commit', () => {
    expect(enterIsImeCommit({ ...base, composing: true })).toBe(true);
    expect(enterIsImeCommit({ ...base, isComposing: true })).toBe(true);
    expect(enterIsImeCommit({ ...base, keyCode: 229 })).toBe(true);
  });

  it('Enter in the instant after compositionend is still the commit', () => {
    // the reported bug: some macOS IMEs end the composition BEFORE the
    // keydown, so the commit arrives looking like an ordinary Enter
    expect(enterIsImeCommit({ ...base, sinceCompositionEnd: 0 })).toBe(true);
    expect(enterIsImeCommit({ ...base, sinceCompositionEnd: 30 })).toBe(true);
  });

  it('a deliberate Enter after the commit still sends', () => {
    expect(enterIsImeCommit({ ...base, sinceCompositionEnd: IME_COMMIT_GRACE_MS + 1 })).toBe(false);
    expect(enterIsImeCommit({ ...base, sinceCompositionEnd: 400 })).toBe(false);
  });

  it('the grace window stays short enough not to eat a second keypress', () => {
    expect(IME_COMMIT_GRACE_MS).toBeLessThanOrEqual(150);
  });
});
