import { describe, expect, it } from 'vitest';
import { isDescendantOf } from './proc-ancestry';

/** a fake process table: pid → parent */
const tree = (pairs: Record<number, number>) => (p: number) => pairs[p];

describe('whether a session-id report comes from inside the session', () => {
  const PTY = 100; // the claude process Ateam launched
  // hook(300) ← shell(200) ← claude(100)
  const inside = tree({ 300: 200, 200: PTY, [PTY]: 50 });

  it('accepts the process itself', () => {
    expect(isDescendantOf(PTY, PTY, inside)).toBe(true);
  });

  it('accepts a child and a grandchild — a hook may run under a shell', () => {
    expect(isDescendantOf(200, PTY, inside)).toBe(true);
    expect(isDescendantOf(300, PTY, inside)).toBe(true);
  });

  it("refuses a fork made outside: the Claude app's background agent", () => {
    // the fork's parent chain reaches the desktop app, never Ateam's PTY
    const outside = tree({ 900: 800, 800: 1 }); // 800 = ClaudeCode.app
    expect(isDescendantOf(900, PTY, outside)).toBe(false);
  });

  it('refuses when the session has no live PTY to descend from', () => {
    expect(isDescendantOf(300, undefined, inside)).toBe(false);
  });

  it('gives up rather than looping on a cycle or a runaway chain', () => {
    expect(isDescendantOf(1, 1, tree({ 1: 1 }))).toBe(true); // itself
    expect(isDescendantOf(2, 999, tree({ 2: 2 }))).toBe(false); // self-parent
    const deep: Record<number, number> = {};
    for (let i = 2; i < 40; i++) deep[i] = i + 1; // 2→3→…→40, ancestor never met
    expect(isDescendantOf(2, 999, tree(deep))).toBe(false);
  });
});
