import { describe, expect, it } from 'vitest';
import { canSubmitRemoteAuth, remoteSignInParams } from './remoteAuth';

describe('remote account form helpers', () => {
  const base = { email: ' person@example.com ', password: 'password8', invite: '', busy: false };

  it('allows sign in without an invite and sends only email and password', () => {
    expect(canSubmitRemoteAuth({ ...base, mode: 'signin' })).toBe(true);
    expect(remoteSignInParams({ ...base, mode: 'signin' })).toEqual({
      email: 'person@example.com',
      password: 'password8',
    });
  });

  it('requires an invite to register and trims it in the request', () => {
    expect(canSubmitRemoteAuth({ ...base, mode: 'register' })).toBe(false);
    const registration = { ...base, mode: 'register' as const, invite: '  ABC-123  ' };
    expect(canSubmitRemoteAuth(registration)).toBe(true);
    expect(remoteSignInParams(registration)).toEqual({
      email: 'person@example.com',
      password: 'password8',
      invite: 'ABC-123',
    });
  });

  it('disables invalid emails, short passwords, and busy submissions', () => {
    expect(canSubmitRemoteAuth({ ...base, mode: 'signin', email: 'not-an-email' })).toBe(false);
    expect(canSubmitRemoteAuth({ ...base, mode: 'signin', password: 'short' })).toBe(false);
    expect(canSubmitRemoteAuth({ ...base, mode: 'signin', busy: true })).toBe(false);
  });
});
