import { describe, expect, it } from 'vitest';
import { rowStarted } from './rowTime';

describe('rowStarted', () => {
  const firstSeen = 1_700_000_000_000;

  it('falls back to firstSeen when createdAt is undefined', () => {
    expect(rowStarted(undefined, firstSeen)).toBe(firstSeen);
  });

  it('falls back to firstSeen for an empty string', () => {
    expect(rowStarted('', firstSeen)).toBe(firstSeen);
  });

  it('falls back to firstSeen for an unparseable string', () => {
    expect(rowStarted('not-a-date', firstSeen)).toBe(firstSeen);
  });

  it('parses a valid ISO-8601 timestamp to epoch ms', () => {
    const iso = '2026-06-05T12:00:00.000Z';
    expect(rowStarted(iso, firstSeen)).toBe(Date.parse(iso));
  });

  it('prefers createdAt over firstSeen when both are present', () => {
    const iso = '2026-01-01T00:00:00.000Z';
    expect(rowStarted(iso, firstSeen)).toBe(Date.parse(iso));
    expect(rowStarted(iso, firstSeen)).not.toBe(firstSeen);
  });
});
