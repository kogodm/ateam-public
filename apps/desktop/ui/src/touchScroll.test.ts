import { describe, expect, it } from 'vitest';
import { takeWheelSteps } from './touchScroll';

const ROW = 20;
const CAP = 12;

describe('finger travel → wheel events', () => {
  it('emits nothing until a whole row has been covered', () => {
    const r = takeWheelSteps(13, ROW, CAP);
    expect(r.steps).toBe(0);
    expect(r.rest).toBe(13); // carried — a slow drag is made of these
  });

  it('emits one event PER ROW so a fast swipe moves as far as the finger did', () => {
    const r = takeWheelSteps(3 * ROW, ROW, CAP);
    expect(r.steps).toBe(3);
    expect(r.deltaY).toBe(ROW);
  });

  it('carries the sub-row remainder into the next batch', () => {
    const r = takeWheelSteps(2.5 * ROW, ROW, CAP);
    expect(r.steps).toBe(2);
    expect(r.rest).toBeCloseTo(0.5 * ROW);
  });

  it('scrolls the other way for upward travel', () => {
    const r = takeWheelSteps(-2 * ROW, ROW, CAP);
    expect(r.steps).toBe(2);
    expect(r.deltaY).toBe(-ROW);
  });

  it('caps a wild flick and drops the excess rather than firing it later', () => {
    const r = takeWheelSteps(100 * ROW, ROW, CAP);
    expect(r.steps).toBe(CAP);
    expect(r.rest).toBe(0);
  });

  it('loses no travel across a jittery slow drag', () => {
    // 30 moves of +3px with a -1px wobble every third: net 50px, so 2 whole
    // rows plus 10px still carried. Discarding on the sign flip (what the old
    // code did) threw away the wobble's whole run-up and emitted nothing.
    let acc = 0;
    let rows = 0;
    for (let i = 0; i < 30; i++) {
      acc += i % 3 === 2 ? -1 : 3;
      const r = takeWheelSteps(acc, ROW, CAP);
      rows += r.steps;
      acc = r.rest;
    }
    expect(rows).toBe(2);
    expect(acc).toBeCloseTo(10);
  });
});
