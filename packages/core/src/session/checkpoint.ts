import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ateamHome } from '../paths';

/**
 * The experience checkpoint: once per compaction cycle, a session past the
 * threshold is told to write what it has learned into its knowledge folder,
 * and carries on — it is NOT replaced.
 *
 * Why it exists: Claude Code compacts a full conversation on its own and
 * keeps only a summary. Ateam's hand-off saves the lessons first, but it is
 * optional (and was off on the machine this was built for — it also kills a
 * session's running sub-agents). The PreCompact hook can make the summary
 * list what was learned, but that is one pass squeezed into the summary's
 * budget, with no reading of what is already stored. Saving BEFORE the
 * compaction, with the whole conversation in context, is the real thing.
 *
 * A cycle: the checkpoint fires once past the threshold and records the
 * token count it fired at. A compaction brings the count far below that, and
 * the next crossing is a new cycle. The marks are kept on disk so a sidecar
 * restart does not fire the same checkpoint a second time.
 */

export interface CheckpointMark {
  /** the session's context size when the checkpoint was sent */
  tokens: number;
  at: string;
}

export type CheckpointDecision = 'fire' | 'rearm' | 'wait';

/** Quiet this long before a checkpoint goes in: the transcript has stopped
 *  growing (between turns, or a long tool call), and the person has not
 *  typed into the session — a paste landing mid-sentence in the terminal's
 *  input box would be appended to what they were writing. */
export const QUIET_TRANSCRIPT_MS = 20_000;
export const QUIET_INPUT_MS = 60_000;

export function checkpointDecision(input: {
  tokens: number;
  threshold: number;
  mark: CheckpointMark | undefined;
  /** ms since the transcript last grew */
  transcriptQuietMs: number;
  /** ms since the person last sent input to the session */
  inputQuietMs: number;
  /** an Ateam hand-off is already under way — it saves the lessons itself */
  handoffInFlight: boolean;
}): CheckpointDecision {
  const { tokens, threshold, mark } = input;
  // a compaction (or a /clear that kept the id) dropped the context well below
  // where the last checkpoint fired: that cycle is over
  if (mark && tokens < mark.tokens / 2) return 'rearm';
  if (mark || tokens < threshold || input.handoffInFlight) return 'wait';
  if (input.transcriptQuietMs < QUIET_TRANSCRIPT_MS) return 'wait';
  if (input.inputQuietMs < QUIET_INPUT_MS) return 'wait';
  return 'fire';
}

const statePath = (): string => join(ateamHome(), 'checkpoint-state.json');

export function loadCheckpointMarks(): Map<string, CheckpointMark> {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Record<string, CheckpointMark>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

export function saveCheckpointMarks(marks: ReadonlyMap<string, CheckpointMark>): void {
  try {
    mkdirSync(ateamHome(), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(Object.fromEntries(marks), null, 2));
  } catch {
    /* best-effort — at worst a restart repeats one checkpoint */
  }
}
