import { describe, expect, it } from 'vitest';
import { fingerprintProblem, normalizeFingerprint } from './fingerprint';

const REAL = 'A8CF08CA2273DD8412345678901234567890ABCDEF1234567890ABCDEF123456';
const COLONS = REAL.match(/../g)?.join(':') ?? '';

describe('normalizeFingerprint', () => {
  it('accepts what the relay CLI prints (colon-separated hex)', () => {
    expect(normalizeFingerprint(COLONS)).toBe(REAL);
  });

  it('accepts bare hex, any case, with stray whitespace', () => {
    expect(normalizeFingerprint(`  ${REAL.toLowerCase()}\n`)).toBe(REAL);
  });

  it("REGRESSION: openssl's label is not mistaken for part of the value", () => {
    // "SHA256 Fingerprint=" is itself full of hex digits (A, 2, 5, 6, F, e) —
    // a plain hex filter silently prepended A256FE to every pasted value
    expect(normalizeFingerprint(`SHA256 Fingerprint=${COLONS}`)).toBe(REAL);
    expect(normalizeFingerprint(`sha256:${COLONS}`)).toBe(REAL);
  });

  it('is empty for an empty input', () => {
    expect(normalizeFingerprint('')).toBe('');
  });
});

describe('fingerprintProblem', () => {
  it('passes a real SHA-256 digest', () => {
    expect(fingerprintProblem(REAL)).toBeUndefined();
  });

  it('names the SHA-1 mistake specifically', () => {
    expect(fingerprintProblem('A'.repeat(40))).toMatch(/SHA-1/);
  });

  it('reports the length otherwise', () => {
    expect(fingerprintProblem('ABCD')).toMatch(/got 4/);
  });
});
