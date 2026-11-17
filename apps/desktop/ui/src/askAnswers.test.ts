import { describe, expect, it } from 'vitest';
import { cleanAnswer, splitAnswers } from './askAnswers';

const FRAME =
  '. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.';

describe('splitAnswers', () => {
  const qs = [
    { question: 'adltv 系列和 ad_revenue_total_X.XX 都像是"累计广告收入达到阈值"，区别是什么?' },
    { question: 'rewarded_ad_watch_N 都是"累计看完激励视频 N 次"，怎么处理?' },
  ];

  it('gives each question its own answer, quotes inside the questions and all', () => {
    const text = `The user answered: "${qs[0]?.question}"="都是累计，adltv 是到到达的时候发一次", "${qs[1]?.question}"="一样的"${FRAME}`;
    expect(splitAnswers(text, qs)).toEqual(['都是累计，adltv 是到到达的时候发一次', '一样的']);
  });

  it('reads the older framing too', () => {
    const text = `Your questions have been answered: "${qs[0]?.question}"="A", "${qs[1]?.question}"="B" You can now continue with the user's answers in mind.`;
    expect(splitAnswers(text, qs)).toEqual(['A', 'B']);
  });

  it('keeps a comma that belongs to an answer', () => {
    const text = `The user answered: "${qs[0]?.question}"="x, y", "${qs[1]?.question}"="z"${FRAME}`;
    expect(splitAnswers(text, qs)?.[0]).toBe('x, y');
  });

  it('is null when the questions are not in the text', () => {
    expect(splitAnswers('The user answered: something else', qs)).toBeNull();
  });
});

describe('cleanAnswer', () => {
  it('drops the framing', () => {
    expect(cleanAnswer(`The user answered: "q"="a"${FRAME}`)).toBe('"q"="a"');
  });
});
