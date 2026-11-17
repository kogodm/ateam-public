import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterDrag, beginDrag, endDrag, isDragging } from './resizeGate';

afterEach(() => {
  // drain any drag a failing expectation left open
  while (isDragging()) endDrag();
  vi.useRealTimers();
});

describe('resizeGate', () => {
  it('runs immediately when nothing is dragging', () => {
    const fn = vi.fn();
    afterDrag(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('holds until the drag lets go', () => {
    const fn = vi.fn();
    beginDrag();
    afterDrag(fn);
    expect(fn).not.toHaveBeenCalled();
    endDrag();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('collapses a drag full of refits into one', () => {
    const fn = vi.fn();
    beginDrag();
    for (let i = 0; i < 20; i++) afterDrag(fn);
    endDrag();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits for the last of nested drags', () => {
    const fn = vi.fn();
    beginDrag();
    beginDrag();
    afterDrag(fn);
    endDrag();
    expect(fn).not.toHaveBeenCalled();
    endDrag();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never goes negative on a stray endDrag', () => {
    endDrag();
    expect(isDragging()).toBe(false);
    const fn = vi.fn();
    beginDrag();
    afterDrag(fn);
    endDrag();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('releases a drag whose mouseup never arrived', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    beginDrag();
    afterDrag(fn);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(1);
    endDrag();
    expect(fn).toHaveBeenCalledTimes(1); // not run twice
  });
});
