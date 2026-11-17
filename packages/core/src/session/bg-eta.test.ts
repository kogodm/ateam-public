import { beforeEach, describe, expect, it } from 'vitest';
import { observeProgress, resetProgressClock, stampedHistory, tqdmTiming } from './bg-eta';
import { progressOf } from './bg-progress';

beforeEach(() => resetProgressClock());

describe('observeProgress', () => {
  it('times a counted figure from how it moves across polls', () => {
    const t0 = 1_000_000;
    const start = t0 - 100_000;
    // the very first look: the since-start average (1000 items in 100s)
    expect(observeProgress('s:a', { done: 1000, total: 9000 }, t0, { startedAtMs: start })).toEqual(
      {
        elapsedSec: 100,
        etaSec: 800,
        rate: 10,
      },
    );
    // then it speeds up to 50/s — the window follows
    for (let i = 1; i <= 8; i++)
      observeProgress('s:a', { done: 1000 + i * 125, total: 9000 }, t0 + i * 2500, {
        startedAtMs: start,
      });
    const r = observeProgress('s:a', { done: 2000, total: 9000 }, t0 + 20_000, {
      startedAtMs: start,
    });
    expect(r).toEqual({ elapsedSec: 120, etaSec: 140, rate: 50 });
  });

  it('restarts on a new phase instead of averaging over the one before', () => {
    const start = 0;
    observeProgress('s:b', { done: 9471, total: 9471 }, 600_000, { startedAtMs: start });
    const r = observeProgress('s:b', { done: 12, total: 9471 }, 602_500, { startedAtMs: start });
    expect(r).toEqual({ elapsedSec: 603 }); // too little history to say
    const r2 = observeProgress('s:b', { done: 112, total: 9471 }, 612_500, { startedAtMs: start });
    expect(r2.rate).toBe(10);
    expect(r2.etaSec).toBe(936);
  });

  it('lets a stall slow the estimate down', () => {
    observeProgress('s:c', { pct: 10 }, 0);
    observeProgress('s:c', { pct: 20 }, 10_000);
    expect(observeProgress('s:c', { pct: 20 }, 12_000).etaSec).toBe(78); // and it has kept going for 2s since
    // no movement for 50s: 10% over 60s now
    expect(observeProgress('s:c', { pct: 20 }, 60_000).etaSec).toBe(480);
  });

  it('times a log that prints every few minutes from its own stamps (color, 09-15)', () => {
    const log = [
      '2026-09-15 15:48:40,002 clip_l14 9471/9471',
      '2026-09-15 15:52:01,132 dinov2_l 32/9471',
      '2026-09-15 15:55:14,032 dinov2_l 3232/9471',
      '',
    ].join('\n');
    const t = (hms: string) => new Date(`2026-09-15T${hms}`).getTime();
    const history = stampedHistory(log, 9471);
    expect(history.map((h) => h.v)).toEqual([32, 3232]); // the clip phase is not this one
    // first look a minute after the last line: not stalled, 3200 per 193s
    const r = observeProgress('s:e', { done: 3232, total: 9471 }, t('15:56:14'), {
      startedAtMs: t('15:30:00'),
      changedAtMs: t('15:55:14'),
      history,
    });
    expect(r.rate).toBeCloseTo(16.58, 1);
    expect(r.etaSec).toBe(316); // 376s at that rate, 60s of it already gone
  });

  it('gives a bare count a rate and never a time left (color watch_66, 09-24)', () => {
    const lines = [
      '09-24 16:05 守护在跑 | batch_d2_320.log 本轮 进度301 发布11 失败1 | 磁盘余 116G',
      '09-24 16:00 batch_d1_240 GEN_DONE（本批失败 0 次）',
    ].join('\n');
    const { progress, lastLine } = progressOf(lines);
    expect(progress).toEqual({ done: 301 });
    expect(lastLine).toContain('GEN_DONE');
    observeProgress('s:n', { done: 301 }, 0);
    const r = observeProgress('s:n', { done: 308 }, 600_000);
    expect(r.etaSec).toBeUndefined();
    expect(r.rate).toBeCloseTo(7 / 600, 6);
  });

  it('wants a label before a bare count', () => {
    expect(progressOf('磁盘余 116G 已进审核 549').progress).toBeUndefined();
    expect(progressOf('processed: 12 files').progress).toEqual({ done: 12 });
    expect(progressOf('GEN_DONE（失败 0 次）').progress).toBeUndefined();
  });

  it('says nothing about a finished figure', () => {
    expect(observeProgress('s:d', { done: 5, total: 5 }, 20_000, { startedAtMs: 0 })).toEqual({
      elapsedSec: 20,
    });
  });
});

describe('tqdm timing', () => {
  it('reads elapsed<remaining and the rate off a tqdm line', () => {
    expect(tqdmTiming('clip_l14:  81%|████████  | 7712/9471 [02:13<00:31, 58.20it/s]')).toEqual({
      elapsedSec: 133,
      etaSec: 31,
      rate: 58.2,
    });
    expect(tqdmTiming('x 3/10 [1:02:13<3:00:01,  3.21s/it]')?.etaSec).toBe(10801);
    expect(tqdmTiming('2026-09-15 15:39:54,019 clip_l14 32/9471')).toBeUndefined();
  });
  it('rides along with the figure progressOf finds', () => {
    const out = progressOf('dinov2:  95%|█████████▌| 8992/9471 [05:01<00:16, 29.8it/s]\r');
    expect(out.progress).toEqual({ done: 8992, total: 9471, pct: 95 });
    expect(out.tqdm).toEqual({ elapsedSec: 301, etaSec: 16, rate: 29.8 });
  });
});
