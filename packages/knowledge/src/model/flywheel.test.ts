import { describe, expect, it } from 'vitest';
import {
  decayConfidence,
  initialConfidence,
  reinforceConfidence,
} from './confidence';
import { deriveProficiency } from './proficiency';
import type { SkillStats } from './types';

const stats = (success: number, applied = success): SkillStats => ({
  applied_count: applied,
  success_count: success,
  failure_count: applied - success,
});

describe('confidence ④', () => {
  it('initializes by basis (below ceiling so it can grow)', () => {
    expect(initialConfidence('single_project', '2026-01-01T00:00:00.000Z').value).toBe(0.5);
    expect(initialConfidence('user_asserted', '2026-01-01T00:00:00.000Z').value).toBe(0.85);
  });

  it('reinforcement grows a fresh asset toward its ceiling', () => {
    let c = initialConfidence('single_project', '2026-01-01T00:00:00.000Z');
    const before = c.value;
    c = reinforceConfidence(c, '2026-01-01T00:00:00.000Z');
    expect(c.value).toBeGreaterThan(before);
    for (let i = 0; i < 30; i++) c = reinforceConfidence(c, '2026-01-01T00:00:00.000Z');
    expect(c.value).toBeLessThanOrEqual(0.75 + 1e-9);
  });

  it('decays when unused over time', () => {
    const c0 = initialConfidence('multi_project', '2026-01-01T00:00:00.000Z');
    const c1 = decayConfidence(c0, '2026-04-01T00:00:00.000Z'); // ~3 months
    expect(c1.value).toBeLessThan(c0.value);
    expect(c1.value).toBeGreaterThan(c0.value - 0.2);
  });

  it('does not decay with no elapsed time', () => {
    const c0 = initialConfidence('declared', '2026-01-01T00:00:00.000Z');
    expect(decayConfidence(c0, '2026-01-01T00:00:00.000Z')).toEqual(c0);
  });

  it('reinforcement moves toward basis ceiling but never exceeds it', () => {
    let c = initialConfidence('multi_project', '2026-01-01T00:00:00.000Z');
    c = decayConfidence(c, '2026-07-01T00:00:00.000Z');
    const before = c.value;
    for (let i = 0; i < 20; i++) c = reinforceConfidence(c, '2026-07-01T00:00:00.000Z');
    expect(c.value).toBeGreaterThan(before);
    expect(c.value).toBeLessThanOrEqual(0.92 + 1e-9);
  });
});

describe('proficiency ③', () => {
  it('declared with no successes', () => {
    expect(deriveProficiency(stats(0), 0.9)).toBe('declared');
  });

  it('practiced on first success', () => {
    expect(deriveProficiency(stats(1), 0.6)).toBe('practiced');
  });

  it('mastered at ≥5 successes and conf≥0.9', () => {
    expect(deriveProficiency(stats(5), 0.9)).toBe('mastered');
  });

  it('not mastered if confidence below 0.9', () => {
    expect(deriveProficiency(stats(9), 0.85)).toBe('practiced');
  });

  it('mastered downgrades to practiced when confidence decays', () => {
    expect(deriveProficiency(stats(9), 0.95)).toBe('mastered');
    expect(deriveProficiency(stats(9), 0.5)).toBe('practiced');
  });

  it('practiced is a permanent floor (single_project basis 0.6 stays practiced)', () => {
    expect(deriveProficiency(stats(1), 0.6)).toBe('practiced');
    expect(deriveProficiency(stats(3), 0.4)).toBe('practiced');
  });
});
