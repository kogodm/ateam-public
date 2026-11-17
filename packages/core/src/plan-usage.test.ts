import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cursorPlanFromResponse,
  readAllPlanUsages,
  readClaudePlanUsage,
  readCodexPlanUsage,
  saveClaudeRateLimits,
} from './plan-usage';

const NOW = Date.parse('2026-10-23T07:00:00Z');
const at = (iso: string) => Date.parse(iso) / 1000;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plan-usage-'));
  process.env.ATEAM_HOME = home;
});
afterEach(() => {
  Reflect.deleteProperty(process.env, 'ATEAM_HOME');
});

describe('claude plan usage', () => {
  it('keeps both windows from the status line input', () => {
    saveClaudeRateLimits(
      {
        five_hour: { used_percentage: 6, resets_at: at('2026-10-23T10:30:00Z') },
        seven_day: { used_percentage: 12, resets_at: at('2026-10-25T10:00:00Z') },
      },
      NOW,
    );
    const u = readClaudePlanUsage(NOW);
    expect(u?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['Current session', 6],
      ['This week', 12],
    ]);
  });

  it('drops a window that has already reset, and says nothing without data', () => {
    expect(readClaudePlanUsage(NOW)).toBeNull();
    saveClaudeRateLimits(
      {
        five_hour: { used_percentage: 90, resets_at: at('2026-10-23T06:00:00Z') },
        seven_day: { used_percentage: 12, resets_at: at('2026-10-25T10:00:00Z') },
      },
      NOW,
    );
    expect(readClaudePlanUsage(NOW)?.windows.map((w) => w.label)).toEqual(['This week']);
  });
});

describe('codex plan usage', () => {
  it('reads the newest rate_limits event of a rollout', () => {
    const file = join(home, 'rollout.jsonl');
    const ev = (used: number, ts: string) =>
      JSON.stringify({
        timestamp: ts,
        payload: {
          rate_limits: {
            primary: {
              used_percent: used,
              window_minutes: 300,
              resets_at: at('2026-10-23T10:00:00Z'),
            },
            secondary: {
              used_percent: 20,
              window_minutes: 10080,
              resets_at: at('2026-10-27T10:00:00Z'),
            },
            plan_type: 'pro',
          },
        },
      });
    writeFileSync(
      file,
      [ev(3, '2026-10-23T05:00:00Z'), '{"x":1}', ev(7, '2026-10-23T06:50:00Z'), '{"half'].join(
        '\n',
      ),
    );
    const u = readCodexPlanUsage(file, NOW);
    expect(u?.plan).toBe('pro');
    expect(u?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['Current session', 7],
      ['This week', 20],
    ]);
  });

  it('is empty for a rollout with no limits or a missing file', () => {
    const file = join(home, 'plain.jsonl');
    writeFileSync(file, '{"type":"x"}\n');
    expect(readCodexPlanUsage(file, NOW)).toBeNull();
    expect(readCodexPlanUsage(join(home, 'none.jsonl'), NOW)).toBeNull();
    expect(readCodexPlanUsage('', NOW)).toBeNull();
  });

  it('caches the last rollout so ChatGPT still shows without a focused codex session', async () => {
    const file = join(home, 'rollout.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        timestamp: '2026-10-23T06:50:00Z',
        payload: {
          rate_limits: {
            primary: {
              used_percent: 47,
              window_minutes: 10080,
              resets_at: at('2026-10-23T09:11:00Z'),
            },
            plan_type: 'prolite',
          },
        },
      }),
    );
    expect(readCodexPlanUsage(file, NOW)?.plan).toBe('prolite');
    const all = await readAllPlanUsages({ cursor: { accessToken: () => null } }, NOW);
    expect(all.map((p) => p.providerId)).toEqual(['codex']);
    expect(all[0]?.windows[0]?.usedPercent).toBe(47);
  });
});

describe('cursor plan usage', () => {
  it('maps auto + api percents onto Cursor Models / Other Models', () => {
    const u = cursorPlanFromResponse(
      {
        billingCycleEnd: String(Date.parse('2026-11-07T06:00:00Z')),
        planUsage: { autoPercentUsed: 34.2, apiPercentUsed: 46.2 },
      },
      'ultra',
      NOW,
    );
    expect(u?.plan).toBe('ultra');
    expect(u?.windows.map((w) => [w.label, Math.round(w.usedPercent)])).toEqual([
      ['Cursor Models', 34],
      ['Other Models', 46],
    ]);
  });

  it('falls back to a single This period bar when only total is set', () => {
    const u = cursorPlanFromResponse(
      {
        billingCycleEnd: String(Date.parse('2026-11-07T06:00:00Z')),
        planUsage: { totalPercentUsed: 55 },
      },
      undefined,
      NOW,
    );
    expect(u?.windows).toEqual([
      { label: 'This period', usedPercent: 55, resetsAt: at('2026-11-07T06:00:00Z') },
    ]);
  });

  it('drops a cycle that has already ended', () => {
    expect(
      cursorPlanFromResponse(
        {
          billingCycleEnd: String(Date.parse('2026-10-01T00:00:00Z')),
          planUsage: { totalPercentUsed: 90 },
        },
        undefined,
        NOW,
      ),
    ).toBeNull();
  });
});

describe('readAllPlanUsages', () => {
  it('stacks Claude, ChatGPT, and Cursor when each source has data', async () => {
    saveClaudeRateLimits(
      { seven_day: { used_percentage: 5, resets_at: at('2026-10-25T10:00:00Z') } },
      NOW,
    );
    const file = join(home, 'rollout.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        timestamp: '2026-10-23T06:50:00Z',
        payload: {
          rate_limits: {
            primary: {
              used_percent: 47,
              window_minutes: 10080,
              resets_at: at('2026-10-23T09:11:00Z'),
            },
            plan_type: 'prolite',
          },
        },
      }),
    );
    const plans = await readAllPlanUsages(
      {
        codexRolloutPath: file,
        cursor: {
          accessToken: () => 'test-token',
          membershipType: () => 'ultra',
          fetchPeriod: async () => ({
            billingCycleEnd: String(Date.parse('2026-11-07T06:00:00Z')),
            planUsage: { autoPercentUsed: 34, apiPercentUsed: 46 },
          }),
        },
      },
      NOW,
    );
    expect(plans.map((p) => p.providerId)).toEqual(['claude', 'codex', 'cursor']);
  });
});
