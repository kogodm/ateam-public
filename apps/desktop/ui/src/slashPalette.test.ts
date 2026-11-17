import { describe, expect, it } from 'vitest';
import { matchSlashCommands, slashKeyAction } from './slashPalette';

const commands = Array.from({ length: 30 }, (_, index) => ({
  name: `command-${index}`,
  source: 'builtin',
}));

describe('slash palette', () => {
  it('keeps commands beyond the former twelve-item limit reachable', () => {
    expect(matchSlashCommands(commands, '/')).toEqual(commands);
    expect(matchSlashCommands(commands, '/command-29')).toEqual([commands[29]]);
    expect(matchSlashCommands(commands, '/command-29 argument')).toEqual([]);
  });
  it('navigates the entire list and completes the selected command', () => {
    expect(slashKeyAction('ArrowDown', '/', commands, 11)).toEqual({ kind: 'select', index: 12 });
    expect(slashKeyAction('ArrowDown', '/', commands, 29)).toEqual({ kind: 'select', index: 0 });
    expect(slashKeyAction('ArrowUp', '/', commands, 0)).toEqual({ kind: 'select', index: 29 });
    expect(slashKeyAction('Enter', '/', commands, 29)).toEqual({
      kind: 'complete',
      text: '/command-29 ',
    });
    expect(slashKeyAction('Tab', '/', commands, 29)).toEqual({
      kind: 'complete',
      text: '/command-29 ',
    });
  });
  it('leaves exact commands for submission, supports dismissal and clamps a changed list', () => {
    expect(slashKeyAction('Enter', '/command-0', commands.slice(0, 1), 29)).toBeUndefined();
    expect(slashKeyAction('Escape', '/', commands, 0)).toEqual({ kind: 'dismiss' });
    expect(slashKeyAction('Enter', '/', [], 0)).toBeUndefined();
  });
});
