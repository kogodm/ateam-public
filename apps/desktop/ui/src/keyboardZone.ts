/**
 * What does this tap mean — type, read, or "not sure"?
 *
 * Pure so it can be tested; the rule has been wrong twice in ways that were
 * invisible from the code.
 *
 * First it was "the bottom 90px of the terminal", on the assumption that the
 * agent's input box sits on the bottom edge. It does not: blank rows follow
 * it, so the box you can SEE was above the zone, tapping it counted as a tap
 * on the conversation and DISMISSED the keyboard.
 *
 * The box is wherever the CURSOR is, so that is what the zone follows — but
 * the cursor is only where the box is once the frame on screen belongs to
 * THIS screen. Right after switching sessions on a phone it does not: the
 * frame was drawn for another width and has not repainted yet, the cursor sits
 * wherever that old frame left it, and every tap on the visible input box fell
 * through to "conversation" — which does not merely fail to open the keyboard,
 * it actively suppresses it. That is why tapping a key-bar button first "fixed"
 * it: sending anything makes the agent repaint, and the cursor lands under the
 * box again.
 *
 * Hence three answers instead of two. When the cursor cannot be trusted the
 * position alone decides, and an ambiguous tap changes NOTHING rather than
 * guessing "dismiss".
 */
export type TapIntent =
  /** open the soft keyboard — the tap is on/below the input box */
  | 'type'
  /** dismiss it — the tap is on the conversation */
  | 'read'
  /** leave the keyboard exactly as it is */
  | 'neither';

export function keyboardTapIntent(args: {
  /** tap position and terminal box, in client px */
  tapY: number;
  hostTop: number;
  hostBottom: number;
  /** height of one terminal row, in css px */
  rowPx: number;
  /** cursor row within the viewport (0-based) */
  cursorY: number;
  rows: number;
  bottomStripPx: number;
}): TapIntent {
  const { tapY, hostTop, hostBottom, rowPx, cursorY, rows, bottomStripPx } = args;
  // under the box, whatever the frame says: unambiguous
  if (tapY > hostBottom - bottomStripPx) return 'type';
  // Trust the cursor only while it is in the lower half: mid-stream the agent
  // parks it anywhere in the frame, and a zone starting there would swallow
  // taps meant for the conversation.
  if (cursorY >= rows / 2) {
    // one row of slack: the cursor sits inside the box, whose top border is the
    // row above — tapping the border is still tapping the box
    return Math.floor((tapY - hostTop) / rowPx) >= cursorY - 1 ? 'type' : 'read';
  }
  const height = hostBottom - hostTop;
  if (tapY > hostBottom - height / 3) return 'type'; // best guess: lower third
  if (tapY < hostTop + height / 2) return 'read'; // clearly the conversation
  return 'neither'; // in between, with nothing to go on — do not touch it
}
