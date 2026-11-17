import type { Proficiency, SkillStats } from './types';

/**
 * Flywheel ③: proficiency is a PURE function of stats + confidence, so it can
 * be re-derived on index rebuild and file/DB always agree.
 *
 *   declared --(first success)--> practiced --(≥5 successes & conf≥0.9)--> mastered
 *
 * Downgrade ("可降级", non-monotonic growth curve): `mastered` is the only
 * confidence-gated tier — if confidence decays below 0.9 it drops back to
 * `practiced`. `practiced` is a permanent floor: once a skill has been applied
 * successfully the agent *has* done it; confidence governs recall weight and
 * mastery, NOT whether the lived experience happened. (A `single_project`
 * skill legitimately sits at confidence 0.6 yet is genuinely `practiced` —
 * collapsing it to `declared` would be wrong.)
 */
export const MASTERY_SUCCESS_THRESHOLD = 5;
export const MASTERY_CONFIDENCE = 0.9;

export function deriveProficiency(stats: SkillStats, confidenceValue: number): Proficiency {
  let level: Proficiency = 'declared';
  if (stats.success_count >= 1) level = 'practiced';
  if (stats.success_count >= MASTERY_SUCCESS_THRESHOLD && confidenceValue >= MASTERY_CONFIDENCE) {
    level = 'mastered';
  }
  // confidence decay strips mastery back to practiced
  if (level === 'mastered' && confidenceValue < MASTERY_CONFIDENCE) level = 'practiced';
  return level;
}
