/**
 * Normalising a pasted TLS certificate fingerprint.
 *
 * The obvious implementation — strip everything that is not a hex digit — is
 * subtly wrong, because the LABELS people paste along with the value are made
 * of hex digits too. `openssl x509 -fingerprint -sha256` prints
 *
 *   SHA256 Fingerprint=A8:CF:08:CA:…
 *
 * and a plain hex filter keeps the `A`, `256`, `F` and `e` out of that prefix,
 * silently prepending `A256FE` to the user's fingerprint. The pasted text looks
 * perfectly right, the comparison fails anyway, and the error points at the
 * certificate rather than at the paste. So: drop any `label=` prefix first,
 * then filter, then insist on the exact length a SHA-256 digest has.
 */

/** 32 bytes as hex */
const SHA256_HEX_LEN = 64;

export function normalizeFingerprint(raw: string): string {
  return raw
    .trim()
    .replace(/^[^=]*=/, '') // "SHA256 Fingerprint=" / "sha256:" style labels
    .replace(/^sha-?256:?/i, '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase();
}

/** Human-readable reason this string cannot be a SHA-256 fingerprint, if any. */
export function fingerprintProblem(normalized: string): string | undefined {
  if (normalized.length === SHA256_HEX_LEN) return undefined;
  if (normalized.length === 40) {
    return 'that is a SHA-1 fingerprint (40 hex chars) — the relay pins SHA-256 (64)';
  }
  return `expected 64 hex characters (SHA-256), got ${normalized.length}`;
}
