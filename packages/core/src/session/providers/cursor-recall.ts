/**
 * Cursor has no verified hidden system-prompt flag. Human recall (skills /
 * meta / codegraph hint) is folded into the positional initial prompt and
 * wrapped so the stream projection can strip it from the visible transcript.
 *
 * Resume without another first message does NOT re-inject: that would submit a
 * new user turn and start the agent on every restore. Fresh launches and any
 * spawn that already carries an initialPrompt (handoff / provider switch) do.
 */
export const CURSOR_RECALL_TAG = 'ateam_human_recall';

export function wrapCursorRecall(recall: string): string {
  return `<${CURSOR_RECALL_TAG}>\n${recall.trim()}\n</${CURSOR_RECALL_TAG}>`;
}

export function buildCursorInitialPrompt(args: {
  appendSystemPrompt?: string;
  initialPrompt?: string;
  resumeSessionId?: string;
}): string | undefined {
  const recall = args.appendSystemPrompt?.trim() ?? '';
  const body = args.initialPrompt?.trim() ?? '';
  const injectRecall = Boolean(recall) && (Boolean(body) || !args.resumeSessionId);
  if (!injectRecall) return body || undefined;
  const wrapped = wrapCursorRecall(recall);
  return body ? `${wrapped}\n\n${body}` : wrapped;
}
