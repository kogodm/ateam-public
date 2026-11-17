/** Auto-handoff "Later" arithmetic (issue #12).
 *
 *  Snoozes are ABSOLUTE token counts, not offsets on the threshold: "ask
 *  me again once this session has grown another `step` from where it is
 *  NOW". An offset-on-threshold snooze re-fires immediately when usage is
 *  already more than one step past the threshold. */
export const HANDOFF_SNOOZE_STEP = 5_000;

/** token count at which to ask again after a Later click at `current`. */
export function nextAskAt(current: number, step = HANDOFF_SNOOZE_STEP): number {
  return Math.max(0, current) + step;
}

/** effective threshold: the configured one, raised to the snooze point when
 *  the user has postponed (undefined = never snoozed). */
export function effectiveThreshold(threshold: number, askAgainAt: number | undefined): number {
  return askAgainAt === undefined ? threshold : Math.max(threshold, askAgainAt);
}
