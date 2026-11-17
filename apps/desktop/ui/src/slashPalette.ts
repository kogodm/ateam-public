export interface SlashSuggestion {
  name: string;
  description?: string;
  source: string;
}

export function matchSlashCommands<T extends SlashSuggestion>(
  commands: readonly T[],
  draft: string,
): T[] {
  const token = /^\/(\S*)$/.exec(draft.trimStart());
  if (!token) return [];
  return commands.filter((command) => command.name.startsWith(token[1] ?? ''));
}

export function slashKeyAction(
  key: string,
  draft: string,
  matches: readonly SlashSuggestion[],
  index: number,
):
  | { kind: 'select'; index: number }
  | { kind: 'complete'; text: string }
  | { kind: 'dismiss' }
  | undefined {
  if (!matches.length) return undefined;
  const selected = Math.min(Math.max(index, 0), matches.length - 1);
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    return {
      kind: 'select',
      index: (selected + (key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length,
    };
  }
  if (key === 'Escape') return { kind: 'dismiss' };
  const command = matches[selected];
  if (command && (key === 'Tab' || (key === 'Enter' && draft.trim() !== `/${command.name}`))) {
    return { kind: 'complete', text: `/${command.name} ` };
  }
  return undefined;
}
