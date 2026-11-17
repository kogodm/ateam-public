import type { Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { readScreen, registerTerm, unregisterTerm } from './termRegistry';

function fakeTerminal(baseY: number, viewportY: number, rows: number): Terminal {
  const term = {
    rows,
    buffer: {
      active: {
        baseY,
        viewportY,
        getLine: (index: number) => ({ translateToString: () => `row-${index}` }),
      },
    },
  };
  return term as unknown as Terminal;
}

describe('termRegistry.readScreen', () => {
  it('reads the latest terminal viewport when scrollback is scrolled up', () => {
    registerTerm('scrolled', fakeTerminal(10, 3, 3));

    expect(readScreen('scrolled')).toEqual(['row-10', 'row-11', 'row-12']);

    unregisterTerm('scrolled');
  });

  it('keeps alternate-buffer baseY zero behavior and returns empty after unregister', () => {
    registerTerm('alternate', fakeTerminal(0, 0, 2));
    expect(readScreen('alternate')).toEqual(['row-0', 'row-1']);

    unregisterTerm('alternate');
    expect(readScreen('alternate')).toEqual([]);
  });
});
