import { describe, expect, it } from 'vitest';
import { effectiveThreshold, nextAskAt } from './handoffSnooze';

describe('handoff snooze (#12)', () => {
  it('asks again one step above CURRENT usage, not above the threshold', () => {
    // threshold 100k, session already at 108k when the dialog shows
    const askAgainAt = nextAskAt(108_000);
    expect(askAgainAt).toBe(113_000);
    expect(effectiveThreshold(100_000, askAgainAt)).toBe(113_000);
    // 108k..112k stays quiet; 113k re-asks
    expect(112_999 >= effectiveThreshold(100_000, askAgainAt)).toBe(false);
    expect(113_000 >= effectiveThreshold(100_000, askAgainAt)).toBe(true);
  });
  it('never lowers the configured threshold', () => {
    expect(effectiveThreshold(100_000, 50_000)).toBe(100_000);
    expect(effectiveThreshold(100_000, undefined)).toBe(100_000);
  });
});
