/**
 * Which session to show when a client (re)connects.
 *
 * Pure so it can be tested. Two rules that matter:
 *  - match on the STABLE claudeSessionId, not the ephemeral sessionId — an
 *    app restart mints new sessionIds for every conversation, and a phone
 *    reconnecting a minute later must land back on the SAME conversation,
 *    not on live[0] (that mismatch once sent a user's message into a dead
 *    id while the screen still showed the right conversation).
 *  - a remembered id is only good while that conversation is still live;
 *    otherwise fall back to the first live session rather than staring at
 *    nothing.
 */
export function pickLandingSession<T extends { sessionId: string; claudeSessionId?: string }>(
  live: readonly T[],
  rememberedId: string,
): T | undefined {
  return (
    live.find((s) => s.claudeSessionId === rememberedId) ??
    // legacy: older builds stored the ephemeral sessionId — honour it once
    live.find((s) => s.sessionId === rememberedId) ??
    live[0]
  );
}
