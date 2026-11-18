import { describe, expect, it } from 'vitest';
import { buildCursorInitialPrompt, wrapCursorRecall } from './cursor-recall';

describe('Cursor recall → initialPrompt', () => {
  it('wraps recall in the stream-hidden tag', () => {
    expect(wrapCursorRecall(' skills ')).toBe(
      '<ateam_human_recall>\nskills\n</ateam_human_recall>',
    );
  });

  it('injects recall on a fresh launch even without another first message', () => {
    expect(buildCursorInitialPrompt({ appendSystemPrompt: 'meta' })).toBe(
      '<ateam_human_recall>\nmeta\n</ateam_human_recall>',
    );
  });

  it('prepends recall when a real first message is already present', () => {
    expect(
      buildCursorInitialPrompt({
        appendSystemPrompt: 'meta',
        initialPrompt: 'Continue the task',
        resumeSessionId: 'chat-1',
      }),
    ).toBe('<ateam_human_recall>\nmeta\n</ateam_human_recall>\n\nContinue the task');
  });

  it('does not re-inject recall on a bare resume', () => {
    expect(
      buildCursorInitialPrompt({
        appendSystemPrompt: 'meta',
        resumeSessionId: 'chat-1',
      }),
    ).toBeUndefined();
  });

  it('passes a plain first message through when there is no recall', () => {
    expect(buildCursorInitialPrompt({ initialPrompt: 'Hello' })).toBe('Hello');
    expect(buildCursorInitialPrompt({})).toBeUndefined();
  });
});
