import { describe, expect, it } from 'vitest';
import { usageRingSlots } from './PanelUsage';

const NOW = Date.parse('2026-11-12T02:00:00Z') / 1000;

describe('usageRingSlots', () => {
  it('lays out five fixed rings from the three providers', () => {
    const slots = usageRingSlots([
      {
        providerId: 'claude',
        updatedAt: 1,
        windows: [
          { label: 'Current session', usedPercent: 35, resetsAt: NOW + 3600 },
          { label: 'This week', usedPercent: 13, resetsAt: NOW + 86400 },
        ],
      },
      {
        providerId: 'codex',
        plan: 'prolite',
        updatedAt: 1,
        windows: [
          { label: 'Current session', usedPercent: 10, resetsAt: NOW + 3600 },
          { label: 'This week', usedPercent: 47, resetsAt: NOW + 86400 },
        ],
      },
      {
        providerId: 'cursor',
        plan: 'ultra',
        updatedAt: 1,
        windows: [
          { label: 'Cursor Models', usedPercent: 39, resetsAt: NOW + 86400 },
          { label: 'Other Models', usedPercent: 48, resetsAt: NOW + 86400 },
        ],
      },
    ]);
    expect(slots.map((s) => s.key)).toEqual([
      'claude-5h',
      'claude-week',
      'gpt',
      'cursor-auto',
      'cursor-api',
    ]);
    expect(slots.map((s) => s.usedPercent)).toEqual([35, 13, 47, 39, 48]);
    expect(slots[2]?.sub).toBe('week');
    expect(slots[2]?.plan).toBe('prolite');
  });

  it('leaves missing providers empty instead of dropping the slot', () => {
    const slots = usageRingSlots([]);
    expect(slots).toHaveLength(5);
    expect(slots.every((s) => s.usedPercent === undefined)).toBe(true);
  });
});
