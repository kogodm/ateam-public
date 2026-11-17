import { describe, expect, it } from 'vitest';
import { isIdleForHibernation } from './manager';

const HOUR = 3600_000;
const now = Date.UTC(2026, 8, 8, 12, 0, 0);
const cutoff = now - 24 * HOUR;
const iso = (t: number): string => new Date(t).toISOString();

describe('when a live session may be hibernated', () => {
  it('sleeps a session whose last record and last use are both past the window', () => {
    expect(isIdleForHibernation(iso(now - 30 * HOUR), now - 30 * HOUR, cutoff)).toBe(true);
  });

  it('leaves a just-woken session alone even though its transcript is old', () => {
    // the bug: wake() resumes a conversation whose newest record is days old,
    // and claude writes nothing until the first turn finishes
    expect(isIdleForHibernation(iso(now - 72 * HOUR), now, cutoff)).toBe(false);
  });

  it('a keystroke keeps it awake with no record written yet', () => {
    expect(isIdleForHibernation(iso(now - 30 * HOUR), now - 5 * 60_000, cutoff)).toBe(false);
  });

  it('recent work keeps it awake even if this process saw nothing', () => {
    expect(isIdleForHibernation(iso(now - HOUR), 0, cutoff)).toBe(false);
  });

  it('leaves a session with no clock at all alone', () => {
    expect(isIdleForHibernation('', 0, cutoff)).toBe(false);
    expect(isIdleForHibernation('not a date', 0, cutoff)).toBe(false);
  });

  it('sleeps a long-quiet session that this process only ever saw at spawn', () => {
    expect(isIdleForHibernation('', now - 40 * HOUR, cutoff)).toBe(true);
  });
});
