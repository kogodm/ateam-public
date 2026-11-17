import { describe, expect, it } from 'vitest';
import { PORT_DEADLINE_MS, nextRecovery } from './port-recovery';

const ask = (o: Partial<Parameters<typeof nextRecovery>[0]> = {}) =>
  nextRecovery({ attempt: 0, elapsedMs: 0, ...o });

describe('getting the LAN port back', () => {
  it('just waits when nobody can be identified — the usual case is a predecessor still letting go', () => {
    expect(ask()).toEqual({ step: 'retry', delayMs: 250 });
  });

  it('backs off, then settles at a steady second', () => {
    expect(ask({ attempt: 1 })).toEqual({ step: 'retry', delayMs: 500 });
    expect(ask({ attempt: 2 })).toEqual({ step: 'retry', delayMs: 1000 });
    expect(ask({ attempt: 9 })).toEqual({ step: 'retry', delayMs: 1000 });
  });

  it('never sleeps past the deadline', () => {
    expect(ask({ attempt: 9, elapsedMs: PORT_DEADLINE_MS - 300 })).toEqual({
      step: 'retry',
      delayMs: 300,
    });
  });

  it('kills our own orphaned sidecar rather than moving off the port', () => {
    // moving would leave the zombie answering on the address every saved
    // phone bookmark points at — two servers, one address
    expect(ask({ holder: { pid: 4242, ours: true } })).toEqual({ step: 'kill', pid: 4242 });
  });

  it('never kills the same pid twice — one TERM, then wait it out', () => {
    expect(ask({ holder: { pid: 4242, ours: true }, killed: [4242] }).step).toBe('retry');
  });

  it("leaves a stranger's process alone and waits instead", () => {
    expect(ask({ holder: { pid: 900, ours: false } }).step).toBe('retry');
  });

  it('takes a new port once the deadline passes, whoever the holder is', () => {
    // availability wins: the relay tunnel follows the config, so remote
    // access survives a move
    expect(ask({ elapsedMs: PORT_DEADLINE_MS })).toEqual({ step: 'move' });
    expect(ask({ elapsedMs: PORT_DEADLINE_MS + 1, holder: { pid: 1, ours: true } })).toEqual({
      step: 'move',
    });
  });
});
