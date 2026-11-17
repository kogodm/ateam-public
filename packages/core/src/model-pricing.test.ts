import { describe, expect, it } from 'vitest';
import { modelPrice, usageCostUsd } from './model-pricing';

describe('model pricing', () => {
  it('prices the current models with cache multipliers', () => {
    expect(modelPrice('claude-opus-5')).toEqual({
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      cacheRead: 0.5,
    });
    expect(modelPrice('claude-sonnet-5')?.cacheRead).toBeCloseTo(0.2);
    // Fable 5.1 has a flat cache-read rate, not 0.1× input
    expect(modelPrice('claude-fable-5-1')?.cacheRead).toBe(0.25);
    expect(modelPrice('claude-fable-5')?.cacheRead).toBe(1);
  });

  it('matches the most specific rule first', () => {
    expect(modelPrice('claude-opus-4-1-20250805')?.input).toBe(15);
    expect(modelPrice('claude-opus-4-6')?.input).toBe(5);
    expect(modelPrice('claude-haiku-4-5-20251001')?.input).toBe(1);
  });

  it('leaves unknown models unpriced', () => {
    expect(modelPrice('<synthetic>')).toBeUndefined();
    expect(modelPrice('gpt-5.6-sol')).toBeUndefined();
    expect(modelPrice(undefined)).toBeUndefined();
    expect(
      usageCostUsd('gpt-5.6-sol', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(0);
  });

  it('sums the four buckets at their own rates', () => {
    const usd = usageCostUsd('claude-opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(5 + 25 + 0.5 + 6.25);
  });
});
