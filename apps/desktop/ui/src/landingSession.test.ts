import { describe, expect, it } from 'vitest';
import { pickLandingSession } from './landingSession';

const live = [
  { sessionId: 'a', claudeSessionId: 'ca' },
  { sessionId: 'b', claudeSessionId: 'cb' },
  { sessionId: 'c', claudeSessionId: 'cc' },
];

describe('which session a reconnecting client lands on', () => {
  it('returns to the remembered session', () => {
    expect(pickLandingSession(live, 'b')?.sessionId).toBe('b');
  });

  it('falls back to the first live session when the remembered one is gone', () => {
    expect(pickLandingSession(live, 'gone')?.sessionId).toBe('a');
  });

  it('falls back to the first live session when nothing is remembered', () => {
    expect(pickLandingSession(live, '')?.sessionId).toBe('a');
  });

  it('has nothing to land on when no session is live', () => {
    expect(pickLandingSession([], 'b')).toBeUndefined();
  });

  it('finds the SAME CONVERSATION by stable id after a restart minted new sessionIds', () => {
    // remembered 'cb' is a claudeSessionId; every sessionId changed,
    // but conversation cb lives on as row b — land there, not on a
    expect(pickLandingSession(live, 'cb')?.sessionId).toBe('b');
  });
});
