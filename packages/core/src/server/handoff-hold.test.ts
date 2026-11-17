import { describe, expect, it } from 'vitest';
import { HeldInput, type HoldDeps, deliverHeld, typeIn } from './handoff-hold';

const P0 = '\x1b[200~';
const P1 = '\x1b[201~';

describe('HeldInput', () => {
  it('turns typed keystrokes into messages (backspace, ^U, Enter)', () => {
    const h = new HeldInput();
    for (const k of ['h', 'e', 'y', 'x', '\x7f', '\r', 'j', 'u', 'n', 'k', '\x15', 'o', 'k'])
      h.feed(k);
    expect(h.messages).toEqual(['hey']);
    expect(h.partial).toBe('ok');
  });

  it('the composer shape: a bracketed paste, then Enter in a separate write', () => {
    const h = new HeldInput();
    expect(h.feed(`${P0}第一行\n第二行${P1}`)).toBe('');
    expect(h.feed('\r')).toBe('');
    expect(h.messages).toEqual(['第一行\n第二行']);
  });

  it('a paste split across chunks is still one message', () => {
    const h = new HeldInput();
    h.feed(`${P0}abc`);
    h.feed(`def${P1}\r`);
    expect(h.messages).toEqual(['abcdef']);
  });

  it('arrows, Esc and Enter on an empty line still reach the old session', () => {
    const h = new HeldInput();
    expect(h.feed('\x1b[B')).toBe('\x1b[B');
    expect(h.feed('\x1b')).toBe('\x1b');
    expect(h.feed('\r')).toBe('\r');
    expect(h.empty).toBe(true);
    // but not other escape sequences, and not an Enter that ends a message
    expect(h.feed('\x1b[3~hi\r')).toBe('');
    expect(h.messages).toEqual(['hi']);
  });

  it('^C abandons the line; Alt+Enter is a newline', () => {
    const h = new HeldInput();
    h.feed('drop me\x03keep\x1b\rme\r');
    expect(h.messages).toEqual(['keep\nme']);
  });
});

function fakeDeps() {
  const writes: string[] = [];
  const timers: { cb: () => void; ms: number }[] = [];
  let turnCb: (() => void) | undefined;
  let unsubscribed = false;
  const deps: HoldDeps = {
    write: (_sid, d) => writes.push(d),
    onFirstTurn: (_sid, cb) => {
      turnCb = cb;
      return () => {
        unsubscribed = true;
      };
    },
    setTimer: (cb, ms) => timers.push({ cb, ms }),
  };
  const runAll = (): void => {
    while (timers.length) timers.shift()?.cb();
  };
  return {
    deps,
    writes,
    timers,
    fireTurn: () => turnCb?.(),
    runAll,
    unsubscribed: () => unsubscribed,
  };
}

describe('delivering held input to the successor', () => {
  it('waits for the successor’s first turn, then sends each message and leaves the partial unsent', () => {
    const h = new HeldInput();
    h.feed(`${P0}one${P1}`);
    h.feed('\r');
    h.feed('two\rhalf');
    const f = fakeDeps();
    deliverHeld(h, 'new', f.deps);
    expect(f.writes).toEqual([]);
    f.fireTurn();
    expect(f.unsubscribed()).toBe(true);
    f.runAll();
    expect(f.writes).toEqual([`${P0}one${P1}`, '\r', `${P0}two${P1}`, '\r', `${P0}half${P1}`]);
  });

  it('delivers once even if the timeout also fires', () => {
    const h = new HeldInput();
    h.feed('x\r');
    const f = fakeDeps();
    deliverHeld(h, 'new', f.deps);
    f.fireTurn();
    f.runAll();
    expect(f.writes).toEqual([`${P0}x${P1}`, '\r']);
  });

  it('nothing held → nothing scheduled', () => {
    const f = fakeDeps();
    deliverHeld(new HeldInput(), 'new', f.deps);
    typeIn(new HeldInput(), 'new', f.deps);
    expect(f.timers).toEqual([]);
    expect(f.writes).toEqual([]);
  });
});
