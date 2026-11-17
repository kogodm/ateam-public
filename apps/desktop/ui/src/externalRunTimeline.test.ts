import { describe, expect, it } from 'vitest';
import type { ExternalRunDTO } from '@ateam/contract';
import { insertExternalRuns, lastConversationItemIndex } from './externalRunTimeline';

type Item = { at: string; text: string };
const itemAt = (item: Item) => item.at;

function run(overrides: Partial<ExternalRunDTO> = {}): ExternalRunDTO {
  return {
    executionId: 'run-a',
    sessionId: 'session-a',
    tool: 'run_command',
    command: 'echo hello',
    status: 'running',
    exitCode: null,
    startedAt: '2026-10-15T10:05:00.000Z',
    endedAt: null,
    output: '',
    truncated: false,
    ...overrides,
  };
}

const message = (text: string, at: string): Item => ({ text, at });
const label = (entry: Item | { kind: 'external_run'; run: ExternalRunDTO }) =>
  'kind' in entry ? entry.run.executionId : entry.text;

describe('insertExternalRuns', () => {
  it('appends runs for an empty transcript in start-time order', () => {
    const result = insertExternalRuns(
      [],
      [run({ executionId: 'later', startedAt: '2026-10-15T10:06:00Z' }), run({ executionId: 'earlier' })],
      itemAt,
    );
    expect(result.map(label)).toEqual(['earlier', 'later']);
  });

  it('inserts before the first transcript item at or after start without sorting messages', () => {
    const items = [
      message('first', '2026-10-15T10:01:00Z'),
      message('second', '2026-10-15T10:10:00Z'),
      message('third', '2026-10-15T10:03:00Z'),
    ];
    const result = insertExternalRuns(items, [run()], itemAt);
    expect(result.map(label)).toEqual(['first', 'run-a', 'second', 'third']);
    expect(result.filter((entry): entry is Item => !('kind' in entry))).toEqual(items);
  });

  it('keeps a completed run at its startedAt position and de-duplicates its execution id', () => {
    const items = [message('before', '2026-10-15T10:00:00Z'), message('after', '2026-10-15T10:10:00Z')];
    const running = run();
    const exited = run({ status: 'exited', exitCode: 0, endedAt: '2026-10-15T10:20:00Z' });
    const result = insertExternalRuns(items, [running, exited], itemAt);
    expect(result.map(label)).toEqual(['before', 'run-a', 'after']);
    expect(result.find((entry) => 'kind' in entry)?.run).toMatchObject({ status: 'exited', exitCode: 0 });
  });

  it('orders concurrent runs with the same start time by execution id', () => {
    const sameTime = '2026-10-15T10:05:00Z';
    const runs = [run({ executionId: 'z', startedAt: sameTime }), run({ executionId: 'a', startedAt: sameTime })];
    const one = insertExternalRuns([], runs, itemAt).map(label);
    const two = insertExternalRuns([], [...runs].reverse(), itemAt).map(label);
    expect(one).toEqual(['a', 'z']);
    expect(two).toEqual(one);
  });

  it('keeps invalid transcript timestamps in place and puts invalid run timestamps last', () => {
    const items = [message('unknown-1', 'bad'), message('dated', '2026-10-15T10:10:00Z'), message('unknown-2', 'bad')];
    const result = insertExternalRuns(
      items,
      [run({ executionId: 'invalid', startedAt: 'not-a-date' }), run({ executionId: 'valid' })],
      itemAt,
    );
    expect(result.map(label)).toEqual(['unknown-1', 'valid', 'dated', 'unknown-2', 'invalid']);
    expect(result.filter((entry): entry is Item => !('kind' in entry))).toEqual(items);
  });

  it('recomputes placement when older transcript history is prepended without duplicating runs', () => {
    const recent = [message('recent', '2026-10-15T10:10:00Z')];
    const older = message('older', '2026-10-15T10:00:00Z');
    const once = insertExternalRuns(recent, [run()], itemAt);
    const loadedMore = insertExternalRuns([older, ...recent], [run(), run()], itemAt);
    expect(once.map(label)).toEqual(['run-a', 'recent']);
    expect(loadedMore.map(label)).toEqual(['older', 'run-a', 'recent']);
  });
});

describe('lastConversationItemIndex', () => {
  it('ignores trailing external runs after the last conversation tool group', () => {
    expect(
      lastConversationItemIndex([
        { kind: 'toolgroup' },
        { kind: 'external_run' },
        { kind: 'external_run' },
      ]),
    ).toBe(0);
  });

  it('finds the last conversation item when an external run is in the middle', () => {
    expect(
      lastConversationItemIndex([{ kind: 'turn' }, { kind: 'external_run' }, { kind: 'toolgroup' }]),
    ).toBe(2);
  });

  it('returns -1 when the list contains only external runs', () => {
    expect(lastConversationItemIndex([{ kind: 'external_run' }, { kind: 'external_run' }])).toBe(-1);
  });
});
