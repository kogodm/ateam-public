import { describe, expect, it } from 'vitest';
import { keyboardTapIntent } from './keyboardZone';

// a phone-shaped terminal: 31 rows of 21px, top at 100
const base = {
  hostTop: 100,
  hostBottom: 751,
  rowPx: 21,
  rows: 31,
  bottomStripPx: 90,
};
const rowY = (row: number): number => base.hostTop + row * base.rowPx + 5;

describe('tapping to raise the keyboard', () => {
  it('opens on the input box even when blank rows follow it', () => {
    // cursor on row 24 of 31 — the box is mid-screen, not on the bottom edge
    expect(keyboardTapIntent({ ...base, cursorY: 24, tapY: rowY(24) })).toBe('type');
  });

  it('opens on the box border a row above the cursor', () => {
    expect(keyboardTapIntent({ ...base, cursorY: 24, tapY: rowY(23) })).toBe('type');
  });

  it('dismisses on the conversation above the box', () => {
    expect(keyboardTapIntent({ ...base, cursorY: 24, tapY: rowY(10) })).toBe('read');
  });

  it('still opens on the empty strip below the box', () => {
    expect(keyboardTapIntent({ ...base, cursorY: 24, tapY: base.hostBottom - 10 })).toBe('type');
  });
});

describe('when the cursor cannot be trusted (frame drawn for another screen)', () => {
  // exactly the state right after switching sessions on a phone: the visible
  // frame has not repainted, so the cursor is nowhere near the input box
  const stale = { ...base, cursorY: 3 };

  it('REGRESSION: a tap in the lower third still opens the keyboard', () => {
    // used to be 'false' → the else branch blurred and set inputmode=none, so
    // the box you could see was a dead zone until a key-bar tap forced a repaint
    expect(keyboardTapIntent({ ...stale, tapY: rowY(22) })).toBe('type');
  });

  it('never DISMISSES on a guess — the middle band leaves the keyboard alone', () => {
    expect(keyboardTapIntent({ ...stale, tapY: base.hostTop + 400 })).toBe('neither');
  });

  it('still dismisses when the tap is clearly on the conversation', () => {
    expect(keyboardTapIntent({ ...stale, tapY: rowY(2) })).toBe('read');
  });

  it('the bottom strip is unconditional', () => {
    expect(keyboardTapIntent({ ...stale, tapY: base.hostBottom - 10 })).toBe('type');
  });
});
