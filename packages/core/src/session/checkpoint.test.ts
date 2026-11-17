import { describe, expect, it } from 'vitest';
import { QUIET_INPUT_MS, QUIET_TRANSCRIPT_MS, checkpointDecision } from './checkpoint';

const quiet = {
  transcriptQuietMs: QUIET_TRANSCRIPT_MS,
  inputQuietMs: QUIET_INPUT_MS,
  handoffInFlight: false,
};

describe('checkpointDecision', () => {
  it('fires once the session is past the threshold and quiet', () => {
    expect(
      checkpointDecision({ tokens: 851_000, threshold: 850_000, mark: undefined, ...quiet }),
    ).toBe('fire');
  });

  it('waits below the threshold', () => {
    expect(
      checkpointDecision({ tokens: 849_000, threshold: 850_000, mark: undefined, ...quiet }),
    ).toBe('wait');
  });

  it('fires only once per cycle', () => {
    const mark = { tokens: 851_000, at: '2026-09-23T07:00:00Z' };
    expect(checkpointDecision({ tokens: 930_000, threshold: 850_000, mark, ...quiet })).toBe(
      'wait',
    );
  });

  it('re-arms after a compaction brought the context far below where it fired', () => {
    const mark = { tokens: 851_000, at: '2026-09-23T07:00:00Z' };
    expect(checkpointDecision({ tokens: 12_000, threshold: 850_000, mark, ...quiet })).toBe(
      'rearm',
    );
  });

  it('never goes in mid-turn, over the person typing, or on top of a hand-off', () => {
    const base = { tokens: 900_000, threshold: 850_000, mark: undefined };
    expect(checkpointDecision({ ...base, ...quiet, transcriptQuietMs: 3_000 })).toBe('wait');
    expect(checkpointDecision({ ...base, ...quiet, inputQuietMs: 10_000 })).toBe('wait');
    expect(checkpointDecision({ ...base, ...quiet, handoffInFlight: true })).toBe('wait');
  });
});
