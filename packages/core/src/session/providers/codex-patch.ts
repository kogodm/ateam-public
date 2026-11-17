import type { Turn } from '@ateam/contract';

type FilePatch = NonNullable<Turn['patch']>[number];
type Hunk = FilePatch['hunks'][number];

export function codexPatch(changes: unknown): NonNullable<Turn['patch']> {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return [];
  const patches: FilePatch[] = [];
  let remaining = 400;
  for (const [path, raw] of Object.entries(changes).slice(0, 100)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const change = raw as Record<string, unknown>;
    const hunks: Hunk[] = [];
    let dropped = 0;
    let current: { oldStart: number; newStart: number; lines: string[] } | undefined;
    const addLine = (line: string): void => {
      if (!current) return;
      if (remaining <= 0) {
        dropped++;
        return;
      }
      current.lines.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
      remaining--;
    };
    if ((change.type === 'add' || change.type === 'delete') && typeof change.content === 'string') {
      current = {
        oldStart: change.type === 'add' ? 0 : 1,
        newStart: change.type === 'delete' ? 0 : 1,
        lines: [],
      };
      hunks.push(current);
      const lines = change.content.split('\n');
      if (lines.at(-1) === '') lines.pop();
      for (const line of lines) addLine(`${change.type === 'add' ? '+' : '-'}${line}`);
    } else if (change.type === 'update' && typeof change.unified_diff === 'string') {
      for (const line of change.unified_diff.split('\n')) {
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (header) {
          current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
          hunks.push(current);
        } else if (current && /^[ +\-]/.test(line)) addLine(line);
      }
    } else continue;
    patches.push({
      file: typeof change.move_path === 'string' && change.move_path ? change.move_path : path,
      hunks: hunks.filter((hunk) => hunk.lines.length > 0),
      ...(dropped ? { dropped } : {}),
    });
  }
  return patches;
}
