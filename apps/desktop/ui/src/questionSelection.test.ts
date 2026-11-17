import { describe, expect, it } from 'vitest';
import { hasAnswerForQuestion } from './questionSelection';

describe('AskUserQuestion selection scope', () => {
  it('keeps later questions unselected when an earlier question has an answer', () => {
    const picked = new Set(['0:1']);
    expect(hasAnswerForQuestion(picked, 0)).toBe(true);
    expect(hasAnswerForQuestion(picked, 1)).toBe(false);
  });

  it('locks only other single-select options in the same question', () => {
    const picked = new Set(['1:2']);
    const qi = 1;
    expect(hasAnswerForQuestion(picked, qi)).toBe(true);
    expect(picked.has(`${qi}:2`)).toBe(true);
    expect(picked.has(`${qi}:0`)).toBe(false);
    expect(hasAnswerForQuestion(picked, 0)).toBe(false);
  });

  it('does not enable Confirm for an unanswered multi-select question', () => {
    const picked = new Set(['0:0']);
    expect(hasAnswerForQuestion(picked, 1)).toBe(false);
  });

  it('counts selections from multiple questions only within their own scope', () => {
    const picked = new Set(['0:0', '0:2', '1:1']);
    expect(hasAnswerForQuestion(picked, 0)).toBe(true);
    expect(hasAnswerForQuestion(picked, 1)).toBe(true);
    expect(hasAnswerForQuestion(picked, 2)).toBe(false);
  });
});
