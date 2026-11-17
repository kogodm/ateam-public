import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Turn } from '@ateam/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from './manager';

const HANDOFF_INTRO = 'I am taking over from a previous session that hit the context limit.';
const row = (content: string): string =>
  `${JSON.stringify({ type: 'user', timestamp: '2026-10-15T12:00:00Z', message: { role: 'user', content } })}\n`;
const queued = (content: string): string =>
  `${JSON.stringify({
    type: 'attachment',
    timestamp: '2026-10-15T12:00:00Z',
    attachment: { type: 'queued_command', prompt: content },
  })}\n`;
const handoff = (bodyLength: number): string =>
  `${HANDOFF_INTRO}\n\n--- HANDOFF ---\n${'x'.repeat(bodyLength)}\n--- END HANDOFF ---`;

type Watch = {
  timer: ReturnType<typeof setInterval>;
  watcher?: { close(): void };
  path: string;
  offset: number;
  seq: number;
  lastAppendAt: number;
};

describe('live session.turn text caps', () => {
  let home: string;
  let file: string;
  let manager: SessionManager;
  let sessionId: string;
  let timer: ReturnType<typeof setInterval>;
  let poll: (sessionId: string) => void;
  let stop: (sessionId: string) => void;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-turn-event-cap-'));
    vi.stubEnv('ATEAM_HOME', join(home, 'ateam'));
    file = join(home, 'transcript.jsonl');
    writeFileSync(file, '');
    manager = new SessionManager();
    sessionId = manager.addHibernated({
      projectName: 'Fixture',
      agentName: 'Fixture',
      role: 'coder',
      dir: home,
      claudeSessionId: '44444444-4444-4444-8444-444444444444',
      providerId: 'claude',
    }).sessionId;
    const internals = manager as unknown as {
      turnWatch: Map<string, Watch>;
      pollTurns(sessionId: string): void;
      stopTurnWatch(sessionId: string): void;
    };
    poll = (id) => internals.pollTurns(id);
    stop = (id) => internals.stopTurnWatch(id);
    timer = setInterval(() => {}, 60_000);
    timer.unref();
    internals.turnWatch.set(sessionId, {
      timer,
      path: file,
      offset: 0,
      seq: 0,
      lastAppendAt: 0,
    });
  });

  afterEach(() => {
    stop(sessionId);
    manager.shutdown();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps a typical handoff complete, caps oversized handoffs at 42KB and other turns at 2KB', () => {
    const typical = handoff(40_000);
    const oversized = handoff(43_000);
    appendFileSync(
      file,
      row(typical) + row(oversized) + queued('m'.repeat(3000)) + row('n'.repeat(3000)),
    );
    const emitted: Turn[] = [];
    manager.on('turn', (event: { turn: Turn }) => emitted.push(event.turn));

    poll(sessionId);

    expect(emitted).toHaveLength(4);
    expect(emitted[0]).toMatchObject({ injected: 'handoff', text: typical });
    expect(emitted[1]?.injected).toBe('handoff');
    expect(emitted[1]?.text).toBe(`${oversized.slice(0, 42_000)}…`);
    expect(emitted[2]).toMatchObject({ injected: 'mid_turn' });
    expect(emitted[2]?.text).toBe(`${'m'.repeat(2000)}…`);
    expect(emitted[3]?.text).toBe(`${'n'.repeat(2000)}…`);
  });

  it('continues to emit only the most recent 40 turns from one transcript batch', () => {
    appendFileSync(file, Array.from({ length: 45 }, (_, i) => row(`message-${i}`)).join(''));
    const emitted: Turn[] = [];
    manager.on('turn', (event: { turn: Turn }) => emitted.push(event.turn));

    poll(sessionId);

    expect(emitted).toHaveLength(40);
    expect(emitted[0]?.text).toBe('message-5');
    expect(emitted.at(-1)?.text).toBe('message-44');
  });
});
