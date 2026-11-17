/**
 * Turning finger travel into wheel events, the arithmetic half.
 *
 * Pure so it can be tested; the reason it exists at all is that xterm turns a
 * wheel event into AT MOST ONE wheel report no matter how large its deltaY is
 * (`bindMouse` in Terminal.ts bails right after the first). So the travel has
 * to be handed over one row at a time — batching a fast swipe into a single
 * fat event scrolled one row and threw the rest away, which is why swiping
 * never tracked the finger.
 */
export function takeWheelSteps(
  acc: number,
  rowPx: number,
  cap: number,
): { steps: number; deltaY: number; rest: number } {
  const dir = Math.sign(acc);
  const whole = Math.trunc(Math.abs(acc) / rowPx);
  const steps = Math.min(whole, cap);
  // Sub-row travel is CARRIED, never dropped: it is what a slow drag is made
  // of. Travel past the cap is dropped instead — a flick that big is already
  // beyond any useful speed, and carrying it would keep firing rows long
  // after the finger stopped.
  const rest = whole > cap ? 0 : acc - dir * steps * rowPx;
  return { steps, deltaY: dir * rowPx, rest };
}
