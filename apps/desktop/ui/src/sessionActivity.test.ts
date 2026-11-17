import { describe, expect, it } from 'vitest';
import { isWithinActiveWindow, sessionActivityMs } from './sessionActivity';

const NOW = Date.parse('2026-11-12T02:00:00.000Z');
const H = 3600_000;

describe('sessionActivityMs', () => {
  it('prefers lastActiveAt over createdAt', () => {
    expect(
      sessionActivityMs({
        lastActiveAt: '2026-11-11T20:00:00.000Z',
        createdAt: '2026-11-01T00:00:00.000Z',
      }),
    ).toBe(Date.parse('2026-11-11T20:00:00.000Z'));
  });

  it('prefers a live turn over a staler lastActiveAt', () => {
    expect(
      sessionActivityMs({
        lastActiveAt: '2026-11-11T10:00:00.000Z',
        lastTurnMs: Date.parse('2026-11-11T22:00:00.000Z'),
      }),
    ).toBe(Date.parse('2026-11-11T22:00:00.000Z'));
  });

  it('falls back to createdAt when nothing has spoken yet', () => {
    expect(sessionActivityMs({ createdAt: '2026-11-12T01:00:00.000Z' })).toBe(
      Date.parse('2026-11-12T01:00:00.000Z'),
    );
  });

  it('returns 0 when every stamp is missing — never invents now', () => {
    expect(sessionActivityMs({})).toBe(0);
  });
});

describe('isWithinActiveWindow', () => {
  it('keeps a session active 19h ago inside a 24h window', () => {
    expect(isWithinActiveWindow(NOW - 19 * H, 24, NOW)).toBe(true);
  });

  it('hides a session active 25h ago from a 24h window', () => {
    expect(isWithinActiveWindow(NOW - 25 * H, 24, NOW)).toBe(false);
  });

  it('hides activityMs 0 (unknown) instead of treating it as just now', () => {
    expect(isWithinActiveWindow(0, 24, NOW)).toBe(false);
  });
});
