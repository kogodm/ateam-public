import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyModelSwitch, discoverModelMenu } from './modelSwitch';
import type { Rpc } from './rpc';

const footer = 'Enter to set as default · s to use this session only · Esc to cancel';
const claude = (selected = 1) => [
  'Select model',
  `${selected === 1 ? '❯' : ' '} 1. Default (recommended)`,
  `${selected === 2 ? '❯' : ' '} 2. Opus 5.5`,
  footer,
];
const codex = (selected = 1) => [
  'Select Model and Effort',
  `${selected === 1 ? '›' : ' '} 1. gpt-5.6-sol (current)`,
  `${selected === 2 ? '›' : ' '} 2. gpt-5.6-terra`,
  'Press enter to confirm or esc to go back',
];
const confirm = ['Switch model?', '❯ 1. Yes, switch to Opus 5.5', '  2. No, go back'];
const foreign = ['Enable full access?', '› 1. Yes', '  2. No', 'enter select · esc back'];
function harness(initial: string[], script: (data: string, set: (rows: string[]) => void) => void) {
  let screen = initial;
  const writes: string[] = [];
  const request = vi.fn(async (_method: string, params: { data: string }) => {
    writes.push(params.data);
    script(params.data, (rows) => {
      screen = rows;
    });
    return {};
  });
  return { rpc: { request } as unknown as Rpc, rows: () => screen, writes };
}
const target = { n: 2, label: 'Opus 5.5' };
async function finish(job: Promise<unknown>, error?: string) {
  const result = error ? expect(job).rejects.toThrow(error) : expect(job).resolves.toBeUndefined();
  await vi.runAllTimersAsync();
  await result;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('switch before send', () => {
  it.each([true, false])(
    'Claude with confirm=%s uses session-only selection and waits',
    async (withConfirm) => {
      let opened = false;
      const h = harness([], (key, set) => {
        if (key === '\r' && !opened) {
          opened = true;
          set(claude());
        } else if (key === '\x1b[B') set(claude(2));
        else if (key === 's') {
          set([]);
          if (withConfirm) setTimeout(() => set(confirm), 200);
        } else if (key === '\r') set([]);
      });
      await finish(applyModelSwitch(h.rpc, 's', h.rows, 'claude', target));
      expect(h.writes).toEqual(['/model', '\r', '\x1b[B', 's', ...(withConfirm ? ['\r'] : [])]);
      expect(h.rows()).toEqual([]);
    },
  );
  it('Codex keeps the highlighted current effort in its second level', async () => {
    let enters = 0;
    const h = harness([], (key, set) => {
      if (key === '\x1b[B') set(codex(2));
      if (key === '\r') {
        enters++;
        set(
          enters === 1
            ? codex()
            : enters === 2
              ? [
                  'Select Reasoning Level for gpt-5.6-terra',
                  '  1. Low',
                  '› 2. Medium (current)',
                  'Press enter to confirm or esc to go back',
                ]
              : ['Model changed to gpt-5.6-terra medium'],
        );
      }
    });
    await finish(applyModelSwitch(h.rpc, 's', h.rows, 'codex', { n: 2, label: 'gpt-5.6-terra' }));
    expect(h.writes).toEqual(['/model', '\r', '\x1b[B', '\r', '\r']);
  });
  it('reaches a target outside the viewport by its cached number', async () => {
    const h = harness([], (key, set) => {
      if (key === '\r') set(claude());
      if (key === '\x1b[B'.repeat(11))
        set(['Select model', '  11. Other model', '❯ 12. Opus 5.5', '↓ … +1 models', footer]);
      if (key === 's') set([]);
    });
    await finish(
      applyModelSwitch(h.rpc, 's', h.rows, 'claude', { n: 12, label: 'Opus 5.5' + ' extended' }),
      'highlight',
    );
    expect(h.writes.at(-1)).toBe('\x1b');
  });
  it('scrolls to and verifies the cached target before confirming', async () => {
    const h = harness([], (key, set) => {
      if (key === '\r') set(claude());
      if (key === '\x1b[B'.repeat(11))
        set(['Select model', '  11. Other model', '❯ 12. Hidden model', '↓ … +1 models', footer]);
      if (key === 's') set([]);
    });
    await finish(applyModelSwitch(h.rpc, 's', h.rows, 'claude', { n: 12, label: 'Hidden model' }));
    expect(h.writes).toEqual(['/model', '\r', '\x1b[B'.repeat(11), 's']);
  });
  it('rejects a foreign dialog without writes', async () => {
    const h = harness(foreign, () => {});
    await finish(
      applyModelSwitch(h.rpc, 's', h.rows, 'claude', target),
      'Finish the current CLI dialog first',
    );
    expect(h.writes).toEqual([]);
  });
  it('times out when the menu never appears', async () => {
    const h = harness([], () => {});
    await finish(applyModelSwitch(h.rpc, 's', h.rows, 'claude', target), 'model menu');
    expect(h.writes).toEqual(['/model', '\r']);
  });
  it('escapes a highlight mismatch without confirming', async () => {
    const h = harness([], (key, set) => {
      if (key === '\r') set(claude());
    });
    await finish(applyModelSwitch(h.rpc, 's', h.rows, 'claude', target), 'highlight');
    expect(h.writes).toEqual(['/model', '\r', '\x1b[B', '\x1b']);
  });
  it('never confirms an approval that replaces the model menu', async () => {
    const h = harness([], (key, set) => {
      if (key === '\r') set(claude());
      if (key === '\x1b[B') set(foreign);
    });
    await finish(
      applyModelSwitch(h.rpc, 's', h.rows, 'claude', target),
      'Finish the current CLI dialog first',
    );
    expect(h.writes).toEqual(['/model', '\r', '\x1b[B']);
  });
  it('never writes digits or /model arguments, even with a malicious label', async () => {
    const h = harness([], (key, set) => {
      if (key === '\r') set(claude());
    });
    await finish(
      applyModelSwitch(h.rpc, 's', h.rows, 'claude', { n: 2, label: '123\r/model opus' }),
      'highlight',
    );
    expect(h.writes.every((key) => ['/model', '\r', '\x1b[B', '\x1b'].includes(key))).toBe(true);
  });
  it('prefers the cursor over the checkmark on the applied model', async () => {
    const h = harness([], (key, set) => {
      if (key === '\r') set(claude());
      if (key === '\x1b[B')
        set(claude(2).map((row) => (row.includes('Default') ? `${row} ✔` : row)));
      if (key === 's') set([]);
    });
    await finish(applyModelSwitch(h.rpc, 's', h.rows, 'claude', target));
    expect(h.writes.at(-1)).toBe('s');
  });
  it('refuses to confirm a Claude model menu without session-only selection', async () => {
    const withoutSessionOnly = [
      'Select model',
      '  1. Default (recommended)',
      '❯ 2. Opus 5.5',
      'Enter to set as default · Esc to cancel',
    ];
    const h = harness([], (key, set) => {
      if (key === '\r') set(claude().map((row) => row === footer ? withoutSessionOnly[3]! : row));
      if (key === '\x1b[B') set(withoutSessionOnly);
    });
    await finish(
      applyModelSwitch(h.rpc, 's', h.rows, 'claude', target),
      'session-only switch',
    );
    expect(h.writes).toEqual(['/model', '\r', '\x1b[B']);
  });
  it('uses session-only selection when a trusted Claude model menu has no footer', async () => {
    const noFooter = ['Select model', '  1. Default (recommended)', '❯ 2. Opus 5.5'];
    const h = harness([], (key, set) => {
      if (key === '\r') set(claude());
      if (key === '\x1b[B') set(noFooter);
      if (key === 's') set([]);
    });
    await finish(applyModelSwitch(h.rpc, 's', h.rows, 'claude', target));
    expect(h.writes).toEqual(['/model', '\r', '\x1b[B', 's']);
    expect(h.rows()).toEqual([]);
  });
  it('does not accept a confirmation highlighted on No', async () => {
    const h = harness([], (key, set) => {
      if (key === '\r') set(claude());
      if (key === '\x1b[B') set(claude(2));
      if (key === 's') set(['Switch model?', '  1. Yes, switch to Opus 5.5', '❯ 2. No, go back']);
    });
    await finish(applyModelSwitch(h.rpc, 's', h.rows, 'claude', target), 'not on Yes');
    expect(h.writes.at(-1)).toBe('s');
  });
  it('does not finish while a confirmation remains open', async () => {
    let opened = false;
    const h = harness([], (key, set) => {
      if (key === '\r' && !opened) {
        opened = true;
        set(claude());
      }
      if (key === '\x1b[B') set(claude(2));
      if (key === 's') set(confirm);
    });
    await finish(applyModelSwitch(h.rpc, 's', h.rows, 'claude', target), 'did not close');
  });
  it('fails if Codex never opens the reasoning menu', async () => {
    const h = harness([], (key, set) => {
      if (key === '\r') set(codex());
      if (key === '\x1b[B') set(codex(2));
    });
    await finish(
      applyModelSwitch(h.rpc, 's', h.rows, 'codex', { n: 2, label: 'gpt-5.6-terra' }),
      'reasoning menu',
    );
    expect(h.writes).toEqual(['/model', '\r', '\x1b[B', '\r']);
  });
  it('stops writing when the owning session changes', async () => {
    let active = true;
    const h = harness([], () => {
      active = false;
    });
    await finish(
      applyModelSwitch(h.rpc, 's', h.rows, 'claude', target, () => active),
      'session changed',
    );
    expect(h.writes).toEqual(['/model']);
  });
  it('discovers and closes a model menu without choosing it', async () => {
    const h = harness([], (key, set) => {
      if (key === '\r') set(claude());
      if (key === '\x1b') set([]);
    });
    const job = discoverModelMenu(h.rpc, 's', h.rows, 'claude');
    await vi.runAllTimersAsync();
    expect((await job).options[1]?.label).toBe('Opus 5.5');
    expect(h.writes).toEqual(['/model', '\r', '\x1b']);
  });
});
