import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codexCreatedAt,
  codexLastActiveAt,
  codexModel,
  codexRolloutPath,
  codexThreadName,
  discoverCodexThread,
  listCodexThreads,
} from './codex-sessions';

const T1 = '01a0065e-7dcc-7500-8f3c-4c032f30df21';
const T2 = '01a0065d-ec4a-77b0-9238-6c64f7181e1b';

let home: string;
const prevHome = process.env.CODEX_HOME;

function writeRollout(id: string, cwd: string, startedAt: Date, lastAt: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const dir = join(
    home,
    'sessions',
    String(startedAt.getFullYear()),
    p(startedAt.getMonth() + 1),
    p(startedAt.getDate()),
  );
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${startedAt.toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`);
  const meta = {
    timestamp: startedAt.toISOString(),
    type: 'session_meta',
    payload: { session_id: id, id, timestamp: startedAt.toISOString(), cwd },
  };
  const evt = { timestamp: lastAt.toISOString(), type: 'event_msg', payload: { type: 'x' } };
  writeFileSync(file, `${JSON.stringify(meta)}\n${JSON.stringify(evt)}\n`);
  return file;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  process.env.CODEX_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  // biome-ignore lint/performance/noDelete: assigning undefined would store the string "undefined"
  if (prevHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevHome;
});

describe('codex session store', () => {
  function appendRecords(file: string, ...records: unknown[]): void {
    appendFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  }

  function settings(model: unknown, threadId: string = T1) {
    return {
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_id: threadId,
        thread_settings: { model },
      },
    };
  }

  it('updates the model immediately after settings are appended without another turn', () => {
    const file = writeRollout(T1, '/repo', new Date(), new Date());
    appendRecords(file, { type: 'turn_context', payload: { model: 'old-model' } });
    expect(codexModel(T1)).toBe('old-model');
    appendRecords(file, settings('new-model'));
    const before = readFileSync(file, 'utf8');
    expect(codexModel(T1)).toBe('new-model');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('uses the latest usable record in append order across both model sources', () => {
    const file = writeRollout(T1, '/repo', new Date(), new Date());
    appendRecords(file, settings('first'), settings('second'));
    expect(codexModel(T1)).toBe('second');
    appendRecords(file, { type: 'turn_context', payload: { model: 'third' } });
    expect(codexModel(T1)).toBe('third');
  });

  it.each([undefined, null, '', '   ', 42, {}, []])(
    'skips unusable models (%j) and falls back to turn_context',
    (model) => {
      const file = writeRollout(T1, '/repo', new Date(), new Date());
      appendRecords(
        file,
        { type: 'turn_context', payload: { model: 'fallback' } },
        settings(model),
        { type: 'turn_context', payload: { model } },
      );
      expect(codexModel(T1)).toBe('fallback');
    },
  );

  it('rejects settings for other threads, missing ids and incorrect model locations', () => {
    const file = writeRollout(T1, '/repo', new Date(), new Date());
    appendRecords(
      file,
      settings('correct'),
      settings('other-thread', T2),
      { type: 'event_msg', payload: { ...settings('missing-id').payload, thread_id: undefined } },
      {
        type: 'event_msg',
        payload: { type: 'thread_settings_applied', thread_id: T1, model: 'wrong-location' },
      },
    );
    expect(codexModel(T1)).toBe('correct');
  });

  it('ignores message text, wrong event types and partial JSON records', () => {
    const file = writeRollout(T1, '/repo', new Date(), new Date());
    appendRecords(
      file,
      { type: 'turn_context', payload: { model: 'correct' } },
      {
        type: 'response_item',
        payload: {
          ...settings('fake').payload,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(settings('fake')) }],
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'turn_context thread_settings_applied',
          model: 'fake',
        },
      },
      { type: 'response_item', payload: settings('fake').payload },
      { type: 'thread_settings_applied', payload: settings('fake').payload },
    );
    appendFileSync(file, '{"type":"turn_context","payload":{"model":');
    expect(codexModel(T1)).toBe('correct');
  });

  it('returns empty when there is no rollout or no usable model', () => {
    expect(codexModel(T1)).toBe('');
    const file = writeRollout(T1, '/repo', new Date(), new Date());
    appendRecords(file, settings('other', T2), settings(null));
    expect(codexModel(T1)).toBe('');
  });

  it('finds the rollout path and timestamps for a thread', () => {
    const start = new Date(Date.now() - 60_000);
    const last = new Date();
    const file = writeRollout(T1, '/repo', start, last);
    expect(codexRolloutPath(T1)).toBe(file);
    expect(codexRolloutPath(`nope-${T2}`)).toBe('');
    expect(codexCreatedAt(T1)).toBe(start.toISOString());
    expect(codexLastActiveAt(T1)).toBe(last.toISOString());
  });

  it('reads the latest /rename label from session_index.jsonl', () => {
    writeFileSync(
      join(home, 'session_index.jsonl'),
      [
        JSON.stringify({ id: T1, thread_name: 'first', updated_at: 'a' }),
        JSON.stringify({ id: T2, thread_name: 'other', updated_at: 'b' }),
        JSON.stringify({ id: T1, thread_name: 'renamed', updated_at: 'c' }),
        '',
      ].join('\n'),
    );
    expect(codexThreadName(T1)).toBe('renamed');
    expect(codexThreadName(T2)).toBe('other');
    expect(codexThreadName('missing')).toBe('');
  });

  it('discovers the unclaimed thread in the same cwd closest to the spawn time', () => {
    const now = Date.now();
    writeRollout(T2, '/repo', new Date(now - 30_000), new Date(now)); // earlier sibling
    writeRollout(T1, '/repo', new Date(now - 1_000), new Date(now)); // ours
    writeRollout(
      '01a00000-0000-7000-8000-000000000003',
      '/elsewhere',
      new Date(now),
      new Date(now),
    );
    expect(discoverCodexThread('/repo', now, () => false)).toBe(T1);
    // once T1 is claimed, the sibling is the only candidate left in tolerance
    expect(discoverCodexThread('/repo', now, (id) => id === T1)).toBe(T2);
    // nothing in this cwd
    expect(discoverCodexThread('/nowhere', now, () => false)).toBeUndefined();
    // spawn far in the future — every rollout is outside tolerance
    expect(discoverCodexThread('/repo', now + 600_000, () => false)).toBeUndefined();
  });

  it('lists the threads started in a cwd, newest first, with rename + summary', () => {
    const now = Date.now();
    writeRollout(T2, '/repo', new Date(now - 30_000), new Date(now - 30_000));
    writeRollout(T1, '/repo', new Date(now - 1_000), new Date(now));
    writeRollout(
      '01a00000-0000-7000-8000-000000000003',
      '/elsewhere',
      new Date(now),
      new Date(now),
    );
    writeFileSync(
      join(home, 'session_index.jsonl'),
      `${JSON.stringify({ id: T1, thread_name: 'named', updated_at: 'a' })}\n`,
    );
    const rows = listCodexThreads('/repo');
    expect(rows.map((r) => r.id)).toEqual([T1, T2]);
    expect(rows[0]).toMatchObject({ providerId: 'codex', title: 'named' });
    expect(rows[1]?.title).toBe('');
    expect(listCodexThreads('/nowhere')).toEqual([]);
  });
});
