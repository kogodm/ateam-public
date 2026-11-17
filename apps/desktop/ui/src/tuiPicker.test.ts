import { describe, expect, it } from 'vitest';
import {
  type PickerOption,
  freeTextOption,
  keysToNext,
  keysToReach,
  parsePicker,
  typedIn,
} from './tuiPicker';
import multiScreens from './fixtures/claude-2.1.309-multiselect-screens.json';
import { isModelList } from './modelMenuCache';

/** captured from a live claude TUI (/model at 100 cols) */
const MODEL_PICKER = [
  '❯ /model                                                                                            ',
  '',
  '────────────────────────────────────────────────────────────────────────────────────────────────────',
  '  Select model',
  '  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous',
  '  model names, specify with --model.',
  '',
  '    1. Default (recommended)  Opus 5 with 1M context · Best for everyday, complex tasks',
  '  ❯ 2. Opus (1M context) ✔    Opus 5 with 1M context · Best for everyday, complex tasks',
  '    3. Fable                  Fable 5 · Most capable for your hardest and longest-running tasks',
  '    4. Sonnet                 Sonnet 5 · Efficient for routine tasks',
  '    5. Haiku                  Haiku 4.5 · Fastest for quick answers',
  '',
  '  ● High effort (default) ←/→ to adjust',
  '',
  '  Use /fast to turn on Fast mode (Opus 5).',
  '',
  '  Enter to set as default · s to use this session only · Esc to cancel',
];

describe('parsePicker', () => {
  it('reads the /model picker off a real screen', () => {
    const p = parsePicker(MODEL_PICKER);
    expect(p).not.toBeNull();
    expect(p?.options.map((o) => o.n)).toEqual([1, 2, 3, 4, 5]);
    expect(p?.options[2]?.label).toBe('Fable');
    expect(p?.options[2]?.description).toBe(
      'Fable 5 · Most capable for your hardest and longest-running tasks',
    );
    // the ✔ / ❯ row is the current one, and the tick is not part of the label
    expect(p?.options[1]?.label).toBe('Opus (1M context)');
    expect(p?.options[1]?.selected).toBe(true);
    expect(p?.hint).toMatch(/Esc to cancel/);
  });

  it('reads a scrolled footerless Claude model menu with its title and truncation hint', () => {
    const picker = parsePicker([
      'Select model',
      'Your pick becomes the default for new sessions.',
      'For other model names, specify with --model.',
      '',
      '  1. Default (recommended)',
      '  2. Opus 5.5',
      '  3. Sonnet 5.5',
      '  4. Fable 5.5',
      '❯ 5. Haiku 5.5',
      '  6. Opus 4.8',
      '  7. Sonnet 4.8',
      '  8. Haiku 4.5',
      '  9. Opus 4.1',
      '↓ 10. Opus 4.8',
      '… +3 models',
    ]);
    expect(picker?.title).toBe('Select model');
    expect(picker?.options.map((option) => option.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(picker?.options[4]?.selected).toBe(true);
    expect(picker?.options[9]?.label).toBe('Opus 4.8');
    expect(picker?.options[9]?.selected).toBe(false);
    expect(isModelList('claude', picker)).toBe(true);
  });

  it('reads an AskUserQuestion-style picker', () => {
    const p = parsePicker([
      ' ☐ 颜色 ',
      '你最喜欢的颜色是哪一个？',
      '❯ 1. 红',
      '     红色',
      '  2. 黄',
      '     黄色',
      '  3. 蓝',
      '     蓝色',
      '  4. Type something.',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]);
    expect(p?.options).toHaveLength(4);
    expect(p?.options[0]?.label).toBe('红');
    // each description belongs to the option ABOVE it (captured claude 2.1.270)
    expect(p?.options.map((o) => o.description)).toEqual(['红色', '黄色', '蓝色', undefined]);
  });

  it('keeps the whole wrapped question of an AskUserQuestion picker', () => {
    const p = parsePicker([
      ' ☐ 处理方式 ',
      '降档后又补出 8 关，L301–1099 已出 790/799。剩下 9 关：栅栏 4、栅栏+木头 3、大门+冰 2（L386 459',
      '505 539 684 721 810 916 989），全是「回顾/循环」位，不是节点关。怎么处理?',
      '',
      '❯ 1. 换组合 (Recommended)',
      '     换成同档稳定出关的组合再跑。',
      '  2. 再降一档',
      '     保留原组合，再降一档重跑。',
      '  3. Type something.',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]);
    expect(p?.title).toBe(
      '降档后又补出 8 关，L301–1099 已出 790/799。剩下 9 关：栅栏 4、栅栏+木头 3、大门+冰 2（L386 459 505 539 684 721 810 916 989），全是「回顾/循环」位，不是节点关。怎么处理?',
    );
  });

  it("reads AskUserQuestion's final review screen (no footer)", () => {
    const p = parsePicker([
      '←  ☒ 工作风格  ☒ 代码审查  ✔ Submit  →',
      '',
      'Review your answers',
      '',
      ' ● 在编码时，你更倾向于我先进行详细的系统设计规划，还是直接开始实现代码？',
      '   → 先规划',
      '',
      'Ready to submit your answers?',
      '',
      '❯ 1. Submit answers',
      '  2. Cancel',
      '',
      '',
    ]);
    expect(p).toMatchObject({
      title: 'Ready to submit your answers?',
      options: [
        { n: 1, label: 'Submit answers' },
        { n: 2, label: 'Cancel' },
      ],
    });
  });

  it('stays null on an ordinary conversation screen', () => {
    expect(
      parsePicker([
        '⏺ Bash(ls -la)',
        '  ⎿  total 8',
        '     1. this looks like an option',
        '     2. so does this',
        '❯ ',
        '  ⏵⏵ auto mode on (shift+tab to cycle)',
      ]),
    ).toBeNull();
  });

  it('rejects a footer with fewer than two options', () => {
    expect(parsePicker(['  1. only one', 'Enter to select · Esc to cancel'])).toBeNull();
  });

  it('rejects numbering that is not 1..N (misread prose)', () => {
    expect(parsePicker(['  2. two', '  7. seven', 'Enter to select · Esc to cancel'])).toBeNull();
  });

  /**
   * The SAME dialog, drawn once by claude into a 46×45 PTY and read back
   * through an emulator left at xterm's 80×24 default — which is exactly what
   * the stream view was reading on a phone, where every Term is `display:none`
   * and so never gets fitted. The option list and the footer collide off the
   * bottom of a screen two thirds the PTY's height.
   */
  const CLIPPED_BY_A_SHORTER_EMULATOR = [
    '',
    '           Claude Code v2.1.246',
    '  ▝▝ ▝▝    ~/PycharmProjects/ATeam',
    '',
    `${'▔'.repeat(46)}`,
    '   Select model',
    '   Switch between Claude models. Your pick ',
    '   becomes the default for new sessions. ',
    '   For other/previous model names, specify ',
    '   with --model.',
    '',
    '     1. Default (recommende…  Opus 5 with ',
    '                              1M context · ',
    '                              Best for ',
    '                              everyday, ',
    '                              complex tasks',
    '   ❯ 2. Opus (1M context) ✔   Opus 5 with ',
    '                              1M context · ',
    '                              Best for ',
    '   session only ·sEdc to c ncel',
  ];

  it('finds nothing on a frame drawn for a size the emulator is not', () => {
    // NOT to be fixed by loosening the parser: a screen this mangled carries
    // no trustworthy options, and inventing buttons under a live conversation
    // is worse than showing none. The fix belongs at the source — Term adopts
    // the PTY size from session.raw / session.size, so the screen the stream
    // view reads is laid out the way claude drew it.
    expect(parsePicker(CLIPPED_BY_A_SHORTER_EMULATOR)).toBeNull();
  });

  it('still reads the picker when the PTY itself is phone-narrow', () => {
    // narrow is fine — claude truncates labels and wraps descriptions, but the
    // numbered run and the footer are intact because the emulator matches
    const p = parsePicker([
      '   Select model',
      '',
      '     1. Default (recommende…  Opus 5 with ',
      '                              1M context · ',
      '   ❯ 2. Opus (1M context) ✔   Opus 5 with ',
      '                              1M context · ',
      '     3. Fable                 Fable 5 · ',
      '                              Most capable ',
      '',
      '   Enter to set as default · s to use this ',
      '   session only · Esc to cancel',
    ]);
    expect(p?.options.map((o) => o.n)).toEqual([1, 2, 3]);
    expect(p?.options[1]?.selected).toBe(true);
  });
});

describe('a confirmation box, which draws no footer at all', () => {
  /** captured from a live claude 2.1.268: /model on a conversation that
   *  already has a cache asks before switching, and the box ends at its
   *  options — the row below them is blank. */
  const SWITCH_MODEL_CONFIRM = [
    '\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594',
    '   Switch model?',
    '   Your next response will be slower and use more tokens',
    '',
    '   This conversation is cached for the current model. Switching to Fable 5.1 means the full history gets',
    '   re-read on your next message.',
    '',
    '   \u276f 1. Yes, switch to Fable 5.1',
    '     2. No, go back',
    '   ',
  ];

  it('reads it — the marker stands in for the missing footer', () => {
    const p = parsePicker(SWITCH_MODEL_CONFIRM);
    expect(p).not.toBeNull();
    expect(p?.options.map((o) => o.label)).toEqual(['Yes, switch to Fable 5.1', 'No, go back']);
    expect(p?.options[0]?.selected).toBe(true);
    expect(p?.hint).toBe('');
  });

  it('titles it with the question, not the tail of the wrapped explanation', () => {
    expect(parsePicker(SWITCH_MODEL_CONFIRM)?.title).toBe('Switch model?');
  });

  it('stays null when anything is drawn below the options', () => {
    // that shape is a picker whose footer was clipped, not a modal that ends
    // there — see CLIPPED_BY_A_SHORTER_EMULATOR above
    expect(parsePicker([...SWITCH_MODEL_CONFIRM, '  some other line'])).toBeNull();
  });

  it('stays null without the marker — a numbered list can end a screen too', () => {
    expect(
      parsePicker(['⏺ two things to try:', '  1. restart it', '  2. or do not', '']),
    ).toBeNull();
  });
});

describe('codex pickers (captured from a live codex 0.147 PTY)', () => {
  it('reads the model picker — marker is › and the footer says "Press enter"', () => {
    const rows = [
      '  Tip: Try the Desktop app.',
      '  Select Model and Effort',
      '  Access legacy models by running codex -m <model_name> or in your config.toml',
      '› 1. gpt-5.6-sol (current)  Latest frontier agentic coding model.',
      '  2. gpt-5.6-terra          Balanced agentic coding model for everyday work.',
      '  3. gpt-5.6-luna           Fast and affordable agentic coding model.',
      '  Press enter to confirm or esc to go back',
    ];
    const p = parsePicker(rows);
    expect(p).not.toBeNull();
    expect(p?.options.map((o) => o.n)).toEqual([1, 2, 3]);
    expect(p?.options[0]?.label).toBe('gpt-5.6-sol (current)');
    expect(p?.options[0]?.description).toBe('Latest frontier agentic coding model.');
    expect(p?.options[0]?.selected).toBe(true);
    expect(p?.options[1]?.selected).toBe(false);
    expect(p?.title).toBe('Select Model and Effort');
  });

  it('reads the directory-trust prompt, whose footer is only "Press enter to continue"', () => {
    const rows = [
      '  Do you trust the contents of this directory? Working with untrusted contents comes with',
      '  higher risk of prompt injection.',
      '› 1. Yes, continue',
      '  2. No, quit',
      '  Press enter to continue',
    ];
    const p = parsePicker(rows);
    expect(p?.options.map((o) => o.label)).toEqual(['Yes, continue', 'No, quit']);
    expect(p?.options[0]?.selected).toBe(true);
  });

  it('still refuses prose that merely ends in an enter hint', () => {
    expect(parsePicker(['  step 3. do the thing', '  Press enter to continue'])).toBeNull();
  });

  it('still refuses a numbered run that is not 1..N', () => {
    expect(
      parsePicker(['› 1. one', '  3. three', '  Press enter to confirm or esc to go back']),
    ).toBeNull();
  });
});

describe('codex 0.161 multi-step menus', () => {
  it('reads the model step with the compact lowercase footer', () => {
    const picker = parsePicker([
      '  Select Model and Effort',
      '',
      '› 1. GPT-6.1-Sol (current)  Latest workhorse model for coding and everyday work.',
      '  2. GPT-6-Astra            Frontier intelligence for the most demanding work.',
      '',
      '  enter select · esc back',
    ]);
    expect(picker?.title).toBe('Select Model and Effort');
    expect(picker?.options).toHaveLength(2);
  });

  it('reads the reasoning step after selecting a model', () => {
    const picker = parsePicker([
      '  Select Reasoning Level for GPT-6.1-Sol',
      '',
      '  1. Low (default)     Fast responses with lighter reasoning',
      '› 2. Medium (current)  Balances speed and reasoning depth for everyday tasks',
      '  3. High              Greater reasoning depth for complex problems',
      '  4. Extra high        Extra high reasoning depth for complex problems',
      '  5. More reasoning…   Max and Ultra consume usage limits faster',
      '',
      '  enter default · s session · esc back',
    ]);
    expect(picker?.title).toBe('Select Reasoning Level for GPT-6.1-Sol');
    expect(picker?.options).toHaveLength(5);
    expect(picker?.options[1]?.selected).toBe(true);
    expect(picker?.hint).toContain('s session');
  });

  it('preserves wrapped permission descriptions', () => {
    const picker = parsePicker([
      '  Update Model Permissions',
      '',
      '› 1. Ask for approval  Read and edit workspace files and run commands, with approval required for',
      '                       internet access or edits outside the workspace',
      '  2. Approve for me    Only ask for actions detected as potentially unsafe',
      '  3. Full Access       Use with caution: Codex can edit files outside this workspace and access the',
      '                       internet without approval',
      '  4. Read Only         Read workspace files, with approval required for edits or internet access',
      '',
      '  enter select · esc back',
    ]);
    expect(picker?.title).toBe('Update Model Permissions');
    expect(picker?.options).toHaveLength(4);
    expect(picker?.options[0]?.description).toBe(
      'Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace',
    );
    expect(picker?.options[2]?.description).toContain('internet without approval');
  });

  it('reads the advanced reasoning step without losing its usage warning', () => {
    const picker = parsePicker([
      '  Advanced Reasoning',
      '  ⚠ Consumes usage limits faster',
      '',
      '› 1. Max    For difficult problems when quality matters more than speed · higher usage',
      '  2. Ultra  For demanding work using multiple agents · highest usage',
      '',
      '  enter default · s session · esc back',
    ]);
    expect(picker?.title).toBe('Advanced Reasoning — ⚠ Consumes usage limits faster');
    expect(picker?.options.map((option) => option.label)).toEqual(['Max', 'Ultra']);
  });

  it('does not mistake an ordinary numbered response for a compact picker', () => {
    expect(parsePicker(['1. first', '2. second', 'enter your response here'])).toBeNull();
  });
});

describe('freeTextOption', () => {
  const picker = (labels: string[], selected: number) => ({
    hint: 'Enter to select',
    options: labels.map((label, i) => ({ n: i + 1, label, selected: i === selected })),
  });
  it('finds the text row by its placeholder, and by its place once typed into (09-18)', () => {
    const fresh = picker(
      ['消息＋派生内容', '只加密消息正文', 'Type something.', 'Chat about this'],
      0,
    );
    expect(freeTextOption(fresh)?.n).toBe(3);
    expect(typedIn(freeTextOption(fresh) as PickerOption)).toBe('');
    const typed = picker(['消息＋派生内容', '只加密消息正文', '33', 'Chat about this'], 2);
    expect(freeTextOption(typed)?.label).toBe('33');
    expect(typedIn(freeTextOption(typed) as PickerOption)).toBe('33');
  });
  it('reaches it with arrow keys, never its digit', () => {
    const p = picker(['a', 'b', 'Type something.', 'Chat about this'], 0);
    expect(keysToReach(p, p.options[2] as PickerOption)).toBe('\x1b[B\x1b[B');
    const q = picker(['a', 'b', 'Type something.', 'Chat about this'], 3);
    expect(keysToReach(q, q.options[2] as PickerOption)).toBe('\x1b[A');
  });
  it('is absent from an ordinary menu', () => {
    expect(freeTextOption(picker(['Opus', 'Sonnet', 'Haiku'], 0))).toBeUndefined();
  });
});

/** Screens captured from a live Claude Code 2.1.303 at 108x40 (2026-10-18). */
describe('Claude 2.1.303 screens', async () => {
  const screens = (await import('./fixtures/claude-2.1.303-screens.json')).default as Record<
    string,
    string[]
  >;
  const at = (name: string): string[] => screens[name] ?? [];
  const labels = (rows: string[]): string[] | undefined =>
    parsePicker(rows)?.options.map((o) => o.label);

  it('reads the unnumbered trust box, to be answered with the arrows', () => {
    const p = parsePicker(at('trust'));
    expect(p?.numbered).toBe(false);
    expect(p?.options.map((o) => [o.label, o.selected])).toEqual([
      ['No, exit', true],
      ['Yes, I trust this folder', false],
    ]);
    expect(p?.hint).toBe('Enter to confirm · Esc to cancel');
    const yes = p?.options[1];
    if (p && yes) expect(keysToReach(p, yes)).toBe('\x1b[B');
  });

  it('never takes a numbered reply above an unnumbered box for its options', () => {
    const reply = at('numberedReply')
      .filter((r) => r.trim())
      .slice(0, 12);
    const box = at('trust')
      .filter((r) => r.trim())
      .slice(-6);
    expect(labels([...reply, '', ...box])).toEqual(['No, exit', 'Yes, I trust this folder']);
  });

  it('leaves a plain numbered reply alone', () => {
    expect(parsePicker(at('numberedReply'))).toBeNull();
  });

  it('still reads the numbered menus', () => {
    expect(parsePicker(at('modelPicker'))?.options).toHaveLength(10);
    expect(labels(at('askQuestion'))).toEqual([
      'Red',
      'Green',
      'Blue',
      'Type something.',
      'Chat about this',
    ]);
    const perm = parsePicker(at('permission'));
    expect(perm?.title).toBe('Do you want to proceed?');
    expect(perm?.options.map((o) => o.n)).toEqual([1, 2, 3, 4]);
    expect(perm?.numbered).toBeUndefined();
  });
});

/** Screens captured from a live codex 0.162.0 at 108x40 (2026-10-18). */
describe('codex 0.162.0 screens', async () => {
  const screens = (await import('./fixtures/codex-0.162.0-screens.json')).default as Record<
    string,
    string[]
  >;
  const at = (name: string): string[] => screens[name] ?? [];

  it('reads the Full Access confirm drawn over old text by its own heading', () => {
    const p = parsePicker(at('fullAccessConfirm'));
    expect(p?.title).toBe('Enable full access?');
    expect(p?.options.map((o) => o.label)).toEqual(['Yes, continue anyway', 'Cancel']);
  });

  it('reads the confirm when it is drawn over a reply (the stream never showed it)', () => {
    const p = parsePicker(at('fullAccessConfirmOverReply'));
    expect(p?.title).toBe('Enable full access?');
    expect(p?.options.map((o) => [o.label, o.selected])).toEqual([
      ['Yes, continue anyway', true],
      ['Cancel', false],
    ]);
    expect(p?.hint).toBe('enter select · esc back');
  });

  it('leaves a long numbered reply alone', () => {
    expect(parsePicker(at('longNumberedReply'))).toBeNull();
  });

  it('still reads the permissions menu', () => {
    const p = parsePicker(at('permissionsMenu'));
    expect(p?.title).toBe('Update Model Permissions');
    expect(p?.options).toHaveLength(4);
  });

  it('sees the update prompt, so nothing typed into the session answers it', () => {
    const p = parsePicker(at('updatePrompt'));
    expect(p?.options.map((o) => o.label)).toEqual([
      'Update now (runs `npm install -g @openai/codex`)',
      'Skip',
      'Skip until next version',
    ]);
    expect(p?.hint).toBe('enter continue · esc skip');
  });
});

describe('Claude 2.1.309 multi-select questions (captured live)', () => {
  const screens = multiScreens as Record<string, string[]>;

  it('reads the boxes, drops "Next" from the descriptions and keeps the chat row', () => {
    const p = parsePicker(screens['0-initial'] ?? []);
    expect(p?.title).toBe('Which ad formats?');
    expect(p?.multi).toEqual({ nextSelected: false });
    expect(p?.options.map((o) => [o.label, o.checked, o.description])).toEqual([
      ['Rewarded', false, 'Video'],
      ['Interstitial', false, 'Between levels'],
      ['Banner', false, 'Bottom strip'],
      ['AppOpen', false, 'Cold start'],
      ['Type something', false, undefined],
      ['Chat about this', undefined, undefined],
    ]);
  });

  it('follows ticked boxes', () => {
    const p = parsePicker(screens['4-digit3'] ?? []);
    expect(p?.options.map((o) => o.checked)).toEqual([true, true, true, false, false, undefined]);
  });

  it('still reads the picker with the cursor on Next', () => {
    const rows = (screens['0-initial'] ?? []).map((r) =>
      /^ {5}Next$/.test(r) ? '❯    Next' : r.replace(/^❯ /, '  '),
    );
    const p = parsePicker(rows);
    expect(p?.multi).toEqual({ nextSelected: true });
    expect(p?.options).toHaveLength(6);
    expect(keysToNext(p as NonNullable<typeof p>)).toBe('');
  });

  it('walks to Next from anywhere', () => {
    const first = parsePicker(screens['0-initial'] ?? []);
    expect(keysToNext(first as NonNullable<typeof first>)).toBe('\x1b[B'.repeat(5));
    const onChat = (screens['0-initial'] ?? []).map((r) =>
      /^ {2}6\. Chat/.test(r) ? '❯ 6. Chat about this' : r.replace(/^❯ /, '  '),
    );
    const p = parsePicker(onChat);
    expect(keysToNext(p as NonNullable<typeof p>)).toBe('\x1b[A');
  });

  it('finds the text row once it holds typed text, and reads it as ticked', () => {
    const rows = (screens['0-initial'] ?? []).map((r) =>
      /5\. \[ \] Type something/.test(r) ? '  5. [✔] hello' : r,
    );
    const p = parsePicker(rows);
    const text = p && freeTextOption(p);
    expect(text?.label).toBe('hello');
    expect(text?.checked).toBe(true);
    expect(text && typedIn(text)).toBe('hello');
  });

  it('leaves a single-choice picker alone', () => {
    const p = parsePicker([
      ' ☐ 颜色 ',
      '你最喜欢的颜色？',
      '❯ 1. 红',
      '  2. 黄',
      '  3. Type something.',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]);
    expect(p?.multi).toBeUndefined();
  });
});
