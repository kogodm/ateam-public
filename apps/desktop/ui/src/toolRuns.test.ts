import { describe, expect, it } from 'vitest';
import { canGroupTool, groupToolRuns, isRun } from './toolRuns';

// B = command, T = thinking, X = anything else
const shape = (s: string): string =>
  groupToolRuns([...s], (c) => c === 'B')
    .map((x) => (isRun(x) ? `[${x.items.join('')}]` : x))
    .join('');

describe('groupToolRuns', () => {
  it('groups native Codex tools but leaves doors and imports separate', () => {
    expect(canGroupTool('codex', { toolName: 'exec' }, false)).toBe(true);
    expect(canGroupTool('codex', { toolName: 'view_image' }, false)).toBe(true);
    expect(canGroupTool('codex', { toolName: 'exec', historical: true }, false)).toBe(false);
    expect(canGroupTool('codex', { toolName: 'exec' }, true)).toBe(false);
    expect(canGroupTool('claude', { toolName: 'Bash' }, false)).toBe(true);
    expect(canGroupTool('claude', { toolName: 'Read' }, false)).toBe(false);
  });
  it('two or more commands in a row become one run', () => {
    expect(shape('XBBBX')).toBe('X[BBB]X');
  });
  it('a lone command stays a card', () => {
    expect(shape('XBXBX')).toBe('XBXBX');
  });
  it('a thought ends the run and stays in the conversation (09-15: "Running command 28" looked idle)', () => {
    expect(shape('BBTBBBTBX')).toBe('[BB]T[BBB]TBX');
  });
  it('anything else ends the run', () => {
    expect(shape('BBXBB')).toBe('[BB]X[BB]');
  });
  it('counts commands', () => {
    const r = groupToolRuns(['B', 'B', 'B'], (c) => c === 'B')[0];
    expect(isRun(r) && r.commands).toBe(3);
  });
});
