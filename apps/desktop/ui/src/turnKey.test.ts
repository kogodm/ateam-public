import { describe, expect, it } from 'vitest';
import { keyOf } from './turnKey';

describe('keyOf', () => {
  it('tells the enqueue from the queued_command that shares its time and text (Tipsy, 09-15)', () => {
    const at = '2026-09-15T08:39:11.226Z';
    const text = '还是说我需要为每个语言准备一套系统提示词';
    const enqueue = { at, role: 'user', text, queued: true };
    const taken = { at, role: 'user', text };
    expect(keyOf(enqueue)).not.toBe(keyOf(taken));
  });
  it('is stable for an ordinary turn', () => {
    const t = { at: '2026-09-15T08:00:00Z', role: 'tool', text: 'ls' };
    expect(keyOf(t)).toBe(keyOf({ ...t }));
  });
  it('keeps a same-time handoff separate from a regular user turn', () => {
    const turn = { at: '2026-09-15T08:00:00Z', role: 'user', text: 'same text' };
    expect(keyOf({ ...turn, injected: 'handoff' })).not.toBe(keyOf(turn));
  });
});
