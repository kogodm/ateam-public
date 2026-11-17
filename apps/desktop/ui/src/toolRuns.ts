/**
 * Stream view: a burst of shell commands collapses into ONE row.
 *
 * claude often runs eight or ten `Bash` calls in a row — as separate cards
 * that is a wall of identical "Bash cd …" headers. A run is two or more such
 * commands with nothing between them.
 *
 * A thought ends the run. Folding thinking into the run as well turned a long
 * investigation into a single "Running command 28" row that sat unchanged for
 * minutes — it looked idle. Thoughts stay in the conversation, so the fold
 * holds only the commands between two of them.
 */
export type Run<I> = { kind: 'run'; items: I[]; commands: number };

export function canGroupTool(
  providerId: string | undefined,
  tool: {
    toolName?: string;
    historical?: boolean;
  },
  hasDoor: boolean,
): boolean {
  return !tool.historical && !hasDoor && (providerId === 'codex' || tool.toolName === 'Bash');
}

export function groupToolRuns<I>(
  items: readonly I[],
  isCommand: (it: I) => boolean,
): (I | Run<I>)[] {
  const out: (I | Run<I>)[] = [];
  let i = 0;
  while (i < items.length) {
    let end = i;
    while (end < items.length && isCommand(items[end] as I)) end++;
    if (end - i >= 2) {
      out.push({ kind: 'run', items: items.slice(i, end), commands: end - i });
      i = end;
    } else {
      out.push(items[i] as I);
      i++;
    }
  }
  return out;
}

export const isRun = <I>(x: I | Run<I>): x is Run<I> =>
  typeof x === 'object' && x !== null && (x as { kind?: unknown }).kind === 'run';
