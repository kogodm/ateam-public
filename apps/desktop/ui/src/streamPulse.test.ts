import { describe, expect, it } from 'vitest';
import codexScreens from './codex-busy.fixture.json';
import {
  IDLE_TICKS_BEFORE_BELIEVING,
  LOCAL_COMMAND_DONE,
  screenAwaitsSubmit,
  reviewSubmitIsHighlighted,
  screenIsBusy,
  screenRetryLine,
  shouldPulse,
} from './streamPulse';
import { parsePicker } from './tuiPicker';

/** real footers, captured from claude 2.1.246 */
const IDLE_FOOTER = '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent';
const BUSY_FOOTER = '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent';

describe('screenIsBusy', () => {
  it('reads the footer claude only prints while a turn is running', () => {
    expect(screenIsBusy(['❯ ', BUSY_FOOTER])).toBe(true);
    expect(screenIsBusy(['❯ ', IDLE_FOOTER])).toBe(false);
  });

  it('has no opinion when there is no screen to read', () => {
    // a client whose Term never mounted must fall back to the transcript,
    // not be told the session is idle
    expect(screenIsBusy([])).toBeNull();
  });
});

describe('shouldPulse', () => {
  const busySeen = { owesAnswer: true, sawBusyHint: true, idleTicks: 0 };

  it('pulses while the records say a reply is owed', () => {
    expect(shouldPulse(busySeen)).toBe(true);
  });

  it('stops once the terminal has been idle long enough', () => {
    // the /model picker was cancelled: no assistant record will ever arrive
    expect(shouldPulse({ ...busySeen, idleTicks: IDLE_TICKS_BEFORE_BELIEVING })).toBe(false);
  });

  it('rides out the beat between hitting send and claude picking it up', () => {
    expect(shouldPulse({ ...busySeen, idleTicks: IDLE_TICKS_BEFORE_BELIEVING - 1 })).toBe(true);
  });

  it('never lets a claude we have not seen print the hint look idle', () => {
    // an older CLI, or a screen we cannot read: absence proves nothing
    expect(shouldPulse({ owesAnswer: true, sawBusyHint: false, idleTicks: 9999 })).toBe(true);
  });

  it('does not pulse when nothing is owed, however busy the screen looks', () => {
    expect(shouldPulse({ owesAnswer: false, sawBusyHint: true, idleTicks: 0 })).toBe(false);
  });
});

describe('Codex working pulse', () => {
  const codex = {
    providerId: 'codex' as const,
    owesAnswer: false,
    sawBusyHint: true,
    screenBusy: true,
    idleTicks: 0,
  };

  it.each(['busy_waiting_response', 'busy_after_commentary'] as const)(
    'animates on the actual Codex %s screen even after an assistant text record',
    (capture) => {
      const rows = codexScreens.captures[capture];
      expect(screenIsBusy(rows)).toBe(true);
      expect(shouldPulse({ ...codex, screenBusy: screenIsBusy(rows) })).toBe(true);
    },
  );

  it.each(['idle_initial', 'idle_after_cancel', 'approval', 'permissions_menu'] as const)(
    'does not mistake the actual Codex %s screen for work',
    (capture) => {
      const rows = codexScreens.captures[capture];
      expect(screenIsBusy(rows)).toBe(false);
      expect(
        shouldPulse({
          ...codex,
          owesAnswer: true,
          screenBusy: screenIsBusy(rows),
          idleTicks: IDLE_TICKS_BEFORE_BELIEVING,
          waitingForInput: parsePicker(rows) !== null,
        }),
      ).toBe(false);
    },
  );

  it('keeps animating after interim assistant commentary while the terminal is busy', () => {
    expect(shouldPulse(codex)).toBe(true);
  });

  it('starts from a busy screen before any reply or busy hint was previously seen', () => {
    expect(shouldPulse({ ...codex, sawBusyHint: false })).toBe(true);
  });

  it('rides out a brief missing footer, then stops on completion or cancellation', () => {
    expect(shouldPulse({ ...codex, screenBusy: false, idleTicks: 1 })).toBe(true);
    expect(shouldPulse({ ...codex, screenBusy: false, idleTicks: 6 })).toBe(false);
    expect(shouldPulse({ ...codex, owesAnswer: true, screenBusy: false, idleTicks: 6 })).toBe(
      false,
    );
  });

  it('pauses for model menus and permissions rather than animating behind an approval prompt', () => {
    expect(shouldPulse({ ...codex, waitingForInput: true })).toBe(false);
  });

  it('does not animate stale tool history forever when a newly mounted Codex screen is idle', () => {
    expect(
      shouldPulse({
        ...codex,
        owesAnswer: true,
        screenBusy: false,
        sawBusyHint: false,
        idleTicks: 6,
      }),
    ).toBe(false);
  });

  it('falls back to transcript evidence if no terminal was ever available', () => {
    expect(shouldPulse({ ...codex, screenBusy: null, sawBusyHint: false })).toBe(false);
    expect(shouldPulse({ ...codex, owesAnswer: true, screenBusy: null, sawBusyHint: false })).toBe(
      true,
    );
  });

  it('does not change Claude or unknown-provider completion behavior', () => {
    expect(shouldPulse({ ...codex, providerId: 'claude' })).toBe(false);
    expect(shouldPulse({ ...codex, providerId: undefined })).toBe(false);
  });
});

describe('LOCAL_COMMAND_DONE', () => {
  it('recognises a slash command the CLI answered itself', () => {
    expect(
      LOCAL_COMMAND_DONE.test(
        '<command-name>/model</command-name><command-message>model</command-message>' +
          '<command-args></command-args>\n<local-command-stdout>Kept model as Opus 5</local-command-stdout>',
      ),
    ).toBe(true);
  });

  it('leaves a prompt-expanding slash command alone — that one does get a reply', () => {
    expect(
      LOCAL_COMMAND_DONE.test(
        '<command-name>/commit</command-name><command-message>commit</command-message><command-args></command-args>',
      ),
    ).toBe(false);
  });
});

describe('screenAwaitsSubmit', () => {
  it('sees the review screen however the frame is wrapped (09-21)', () => {
    const rows = [
      '  ←  ☐ 1:1.19 尺寸  ☐ 做法  ✔ Submit  →',
      '  Review your answers',
      '  ● 1:1.19 要出多少像素？',
      '    → 1200×1428',
      '  ● 角色需要什么风格？',
      '    → 保持原设计',
      '  ● 是否需要透明背景？',
      '    → 是',
      '  Ready to submit your answers?',
      '  ❯ 1. Submit answers',
      '    2. Cancel',
      '                                   ',
    ];
    expect(screenAwaitsSubmit(rows)).toBe(true);
    expect(
      screenAwaitsSubmit(['Review your answers', '❯ 1. Submit answers']),
    ).toBe(true);
    expect(screenAwaitsSubmit(['❯ 1. Submit answers'])).toBe(true);
    expect(screenAwaitsSubmit(['1. Submit answers', '2. Cancel'])).toBe(true);
    expect(screenAwaitsSubmit(['  ❯ 1. 1080x1285', '    2. 1200x1428'])).toBe(false);
    expect(
      screenAwaitsSubmit([
        'Ready to submit your answers?',
        'Submit answers appears in this code sample',
      ]),
    ).toBe(false);
  });

  it('allows Enter only while the first review option is highlighted', () => {
    expect(reviewSubmitIsHighlighted(['  ❯ 1. Submit answers', '    2. Cancel'])).toBe(true);
    expect(reviewSubmitIsHighlighted(['    1. Submit answers', '  › 2. Cancel'])).toBe(false);
    expect(reviewSubmitIsHighlighted(['  › 1. Submit answers', '    2. Cancel'])).toBe(true);
  });
});

describe('screenRetryLine', () => {
  it('reads the retry line off the screen, without its spinner glyph (09-28)', () => {
    const rows = [
      '    new=re.sub(r\'"renderBackEnd": \\{\\s*"vulkan": true',
      '',
      '* Waiting for API response · will retry in 23s · check your network',
      '  ⏵⏵ auto mode on · esc to interrupt',
    ];
    expect(screenRetryLine(rows)).toBe(
      'Waiting for API response · will retry in 23s · check your network',
    );
  });
  it('null when nothing is being retried', () => {
    expect(screenRetryLine(['✻ Thinking… (12s · esc to interrupt)'])).toBeNull();
    expect(screenRetryLine([])).toBeNull();
  });
});
