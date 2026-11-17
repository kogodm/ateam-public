import type { Confidence, ConfidenceBasis, IsoTimestamp } from './types';

/** Flywheel ④: confidence init / decay / reinforcement. Pure, re-derivable. */

/** Starting confidence for a fresh asset of each basis (below its ceiling so
 *  successful application can visibly grow it — the flywheel's ⑥ growth). */
export const BASIS_INIT: Readonly<Record<ConfidenceBasis, number>> = {
  declared: 0.3,
  single_project: 0.5,
  multi_project: 0.7,
  user_asserted: 0.85,
};

/** Per-basis ceiling: confidence cannot exceed what its basis justifies.
 *  `mastered` (needs ≥0.9) is only reachable once multi-project-verified. */
export const BASIS_CEILING: Readonly<Record<ConfidenceBasis, number>> = {
  declared: 0.5,
  single_project: 0.75,
  multi_project: 0.92,
  user_asserted: 0.95,
};

/** Tuned so an unused asset loses ~0.1 (relative ~11%) per quarter. */
export const DECAY_LAMBDA = 0.04;

export function initialConfidence(basis: ConfidenceBasis, now: IsoTimestamp): Confidence {
  return { value: BASIS_INIT[basis], basis, last_recomputed: now };
}

export function monthsBetween(from: IsoTimestamp, to: IsoTimestamp): number {
  const ms = Date.parse(to) - Date.parse(from);
  return ms <= 0 ? 0 : ms / (1000 * 60 * 60 * 24 * 30);
}

/** Exponential decay since last_recomputed. Never below 0. */
export function decayConfidence(
  c: Confidence,
  now: IsoTimestamp,
  lambda = DECAY_LAMBDA,
): Confidence {
  const months = monthsBetween(c.last_recomputed, now);
  if (months === 0) return c;
  const value = Math.max(0, c.value * Math.exp(-lambda * months));
  return { ...c, value, last_recomputed: now };
}

/** Successful application pulls confidence toward its basis ceiling. */
export function reinforceConfidence(c: Confidence, now: IsoTimestamp): Confidence {
  const ceiling = BASIS_CEILING[c.basis];
  const value = Math.min(ceiling, c.value + (ceiling - c.value) * 0.34);
  return { ...c, value, last_recomputed: now };
}
