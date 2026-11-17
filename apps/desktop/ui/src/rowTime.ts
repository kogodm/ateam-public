/**
 * Pick the epoch-ms origin for a session row's "age" display.
 *
 * Prefers the backend-provided `createdAt` (ISO-8601, the session's real
 * lifetime start which survives GUI restarts) over `firstSeen` (the epoch-ms
 * stamp from the client-side first-seen map, i.e. only the first time THIS
 * GUI run observed the session). Falls back to `firstSeen` when `createdAt`
 * is missing (older persisted sessions) or unparseable, so the formatter
 * always receives a valid number.
 */
export function rowStarted(createdAt: string | undefined, firstSeen: number): number {
  const createdMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(createdMs) ? createdMs : firstSeen;
}
