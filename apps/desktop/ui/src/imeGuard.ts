import { useCallback, useRef } from 'react';

/**
 * "Enter sends" composers versus input methods.
 *
 * With a Chinese/Japanese/Korean IME the Enter that COMMITS the candidate is
 * not a send — the user is mid-sentence. The documented guard is
 * `KeyboardEvent.isComposing` (and its legacy twin, keyCode 229), and for many
 * IMEs that is enough: the commit key arrives while composition is still open.
 *
 * It is not enough for all of them. Several macOS input methods — the case
 * reported here was typing an English word with a Chinese IME active — fire
 * `compositionend` BEFORE the keydown, so the commit Enter reaches the handler
 * with `isComposing` already false and a plain keyCode 13. The message goes
 * out mid-sentence.
 *
 * So the guard also refuses an Enter that lands in the instant after a
 * composition ended. Those two events are microseconds apart; a person who
 * commits and then deliberately presses Enter takes far longer than the
 * window, so a real send is never swallowed.
 */

/** How long after `compositionend` an Enter still counts as the commit. */
export const IME_COMMIT_GRACE_MS = 100;

export interface EnterGuardState {
  /** a composition is open right now */
  composing: boolean;
  /** ms since the last compositionend (Infinity when there has been none) */
  sinceCompositionEnd: number;
  /** the event's own `isComposing` */
  isComposing: boolean;
  /** legacy IME marker some browsers still send instead */
  keyCode: number;
}

/** Whether this Enter belongs to the input method rather than to the user. */
export function enterIsImeCommit(s: EnterGuardState): boolean {
  return (
    s.composing || s.isComposing || s.keyCode === 229 || s.sinceCompositionEnd < IME_COMMIT_GRACE_MS
  );
}

export interface ImeGuard {
  /** spread onto the textarea/input */
  imeProps: {
    onCompositionStart: () => void;
    onCompositionEnd: () => void;
  };
  /** true when this keydown must not be treated as "send" */
  isImeCommit: (e: React.KeyboardEvent) => boolean;
  /** a composition is open right now (for live text rewrites that must wait) */
  isComposing: () => boolean;
}

export function useImeGuard(): ImeGuard {
  const composing = useRef(false);
  const endedAt = useRef(Number.NEGATIVE_INFINITY);

  const onCompositionStart = useCallback(() => {
    composing.current = true;
  }, []);
  const onCompositionEnd = useCallback(() => {
    composing.current = false;
    endedAt.current = performance.now();
  }, []);

  const isImeCommit = useCallback(
    (e: React.KeyboardEvent): boolean =>
      enterIsImeCommit({
        composing: composing.current,
        sinceCompositionEnd: performance.now() - endedAt.current,
        isComposing: e.nativeEvent.isComposing,
        keyCode: (e.nativeEvent as KeyboardEvent).keyCode,
      }),
    [],
  );

  const isComposing = useCallback(() => composing.current, []);

  return { imeProps: { onCompositionStart, onCompositionEnd }, isImeCommit, isComposing };
}
