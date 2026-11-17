import type { ProviderId } from '@ateam/contract';

/**
 * When the stream view's "working" pulse should run — and, more importantly,
 * when it must stop.
 *
 * The transcript alone cannot answer this. A turn can end without ever writing
 * an assistant record: a picker cancelled (/model), an Esc interrupt, a claude
 * that died. The last record then stays a user/tool one and the three dots
 * pulse forever — the "model 消息还在播三个点" report. So the terminal gets a
 * veto: claude's TUI footer offers "esc to interrupt" exactly while a turn is
 * in flight, and a run of polls without it means the work is over whatever the
 * records look like.
 */

/** The TUI footer's offer to interrupt — present only while a turn runs. */
export const BUSY_HINT = /\besc to interrupt\b/i;

/** A slash command the CLI answered itself; its output is in the record. */
export const LOCAL_COMMAND_DONE = /<local-command-stdout>/;

/** Is claude working, as far as this screen shows? `null` = nothing to read. */
/**
 * claude's "Review your answers / Ready to submit your answers? ❯ 1. Submit
 * answers" screen, which ends a multi-question AskUserQuestion and waits for
 * one Enter. parsePicker reads it only when the frame is clean and the
 * options are the last thing drawn; a session sat on it for eleven minutes
 * because neither held (09-21). The numbered choice row plus a review heading,
 * highlight, or Cancel row distinguishes this screen from ordinary prose.
 */
export function screenAwaitsSubmit(rows: readonly string[]): boolean {
  const submitRow = rows.find((r) => /^\s*(?:[❯›]\s*)?1\.\s*Submit answers\s*$/i.test(r));
  if (!submitRow) return false;
  const highlighted = /^\s*[❯›]/.test(submitRow);
  const hasReviewHeading = rows.some((r) => /\bReview your answers\b|\bReady to submit your answers\?/i.test(r));
  const hasCancel = rows.some((r) => /^\s*(?:[❯›]\s*)?2\.\s*Cancel\s*$/i.test(r));
  return highlighted || hasReviewHeading || hasCancel;
}

/** Only press Enter when the Review screen currently highlights its submit row. */
export function reviewSubmitIsHighlighted(rows: readonly string[]): boolean {
  return rows.some((r) => /^\s*[❯›]\s*1\.\s*Submit answers\s*$/i.test(r));
}

export function screenIsBusy(rows: readonly string[]): boolean | null {
  if (rows.length === 0) return null;
  return rows.some((r) => BUSY_HINT.test(r));
}

/** A line claude draws while an API request is failing and being retried —
 *  "Waiting for API response · will retry in 23s · check your network". It
 *  is only on the screen: the transcript gets nothing until the retries give
 *  up (then an `isApiErrorMessage` record), so the stream showed a quiet
 *  pulse while the terminal said the network was down (09-28). */
const RETRY_RE =
  /Waiting for API response|will retry in \d+\s*s|Retrying in \d+|retry attempt \d+/i;

/** that line, cleaned of the spinner glyph in front of it; null when absent */
export function screenRetryLine(rows: readonly string[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] ?? '';
    if (!RETRY_RE.test(r)) continue;
    return (
      r
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .replace(/\s+/g, ' ')
        .trim() || null
    );
  }
  return null;
}

/** Polls without the hint before we believe the terminal over the transcript.
 *  Long enough to cover the beat between hitting send and claude picking the
 *  turn up, which would otherwise blink the pulse out at the worst moment. */
export const IDLE_TICKS_BEFORE_BELIEVING = 6; // ×500ms

export function shouldPulse(s: {
  /** the records still look like claude owes a reply */
  owesAnswer: boolean;
  /** we have seen this session's TUI print the hint at least once */
  sawBusyHint: boolean;
  /** consecutive polls with a readable screen and no hint on it */
  idleTicks: number;
  providerId?: ProviderId;
  screenBusy?: boolean | null;
  waitingForInput?: boolean;
}): boolean {
  if (s.providerId === 'codex') {
    if (s.waitingForInput) return false;
    if (s.screenBusy === true) return true;
    if (s.screenBusy === false && s.idleTicks >= IDLE_TICKS_BEFORE_BELIEVING) return false;
    if (s.sawBusyHint && s.idleTicks < IDLE_TICKS_BEFORE_BELIEVING) return true;
  }
  if (!s.owesAnswer) return false;
  // Never trust the ABSENCE of the hint from a claude we have never seen print
  // it: an older CLI, or a screen we could not read, would otherwise look
  // permanently idle and the pulse would never show at all.
  if (!s.sawBusyHint) return true;
  return s.idleTicks < IDLE_TICKS_BEFORE_BELIEVING;
}
