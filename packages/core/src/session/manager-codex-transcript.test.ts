import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Turn } from '@ateam/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from './manager';

const THREAD = '44444444-4444-4444-8444-444444444444';
const row = (type: string, payload: unknown) =>
  `${JSON.stringify({ timestamp: '2026-10-08T12:00:00Z', type, payload })}\n`;
const call = row('response_item', {
  type: 'custom_tool_call',
  name: 'exec',
  call_id: 'fixture-call',
  input: 'text("fixture");',
});
const output = row('response_item', {
  type: 'custom_tool_call_output',
  call_id: 'fixture-call',
  output: 'fixture output',
});
const visual = row('event_msg', {
  type: 'item_completed',
  item: { type: 'Extension', id: 'fixture-call', kind: 'exec', query: 'text("fixture");' },
});
let home: string;
let file: string;
let manager: SessionManager;
let sessionId: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ateam-codex-projection-'));
  vi.stubEnv('ATEAM_HOME', join(home, 'ateam'));
  vi.stubEnv('CODEX_HOME', home);
  const dir = join(home, 'sessions', '2026', '10', '08');
  mkdirSync(dir, { recursive: true });
  file = join(dir, `rollout-fixture-${THREAD}.jsonl`);
  writeFileSync(file, row('session_meta', { id: THREAD, cwd: home }));
  manager = new SessionManager();
  sessionId = manager.addHibernated({
    projectName: 'Fixture',
    agentName: 'Fixture',
    role: 'coder',
    dir: home,
    claudeSessionId: THREAD,
    providerId: 'codex',
  }).sessionId;
});

afterEach(() => {
  manager.shutdown();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('Codex tool source wiring', () => {
  it('keeps native output after a raw call until a raw output is available', () => {
    const native = row('event_msg', {
      type: 'item_completed',
      item: { type: 'FunctionCallOutput', id: 'fixture-call', output: 'native result' },
    });
    appendFileSync(file, call + native);
    expect(manager.transcript(sessionId).map((turn) => turn.text)).toEqual([
      'text("fixture");',
      'native result',
    ]);
    appendFileSync(file, output);
    const history = manager.transcript(sessionId);
    expect(history.map((turn) => turn.text)).toEqual(['text("fixture");', 'fixture output']);
    expect(manager.transcriptBefore(sessionId, statSync(file).size, 8192).turns).toEqual(history);
  });

  it('collects IDs before parsing a batch and preserves unrelated native tools on every reader', () => {
    const native = row('event_msg', {
      type: 'item_completed',
      item: { type: 'ImageView', id: 'nested-image', path: '/nested.png' },
    });
    appendFileSync(file, visual + native + call + output);
    const history = manager.transcript(sessionId);
    expect(history.map((turn) => turn.toolUseId)).toEqual([
      'nested-image',
      'nested-image',
      'fixture-call',
      'fixture-call',
    ]);
    expect(manager.transcriptBefore(sessionId, statSync(file).size, 8192).turns).toEqual(history);
  });

  it('bounds accumulated IDs and resets them when the rollout path changes', () => {
    const internals = manager as unknown as {
      codexSource(
        session: object,
        path: string,
        lines: string[],
      ): { toolSource?: string; responseCallIds: Set<string>; responseOutputIds: Set<string> };
    };
    const session = {};
    const lines = Array.from({ length: 20001 }, (_, index) =>
      row('response_item', { type: 'function_call_output', call_id: `call-${index}`, output: '' }),
    );
    const options = internals.codexSource(session, '/fixture-a', lines);
    expect(options.responseCallIds.size).toBe(20000);
    expect(options.responseCallIds.has('call-0')).toBe(false);
    expect(options.responseCallIds.has('call-20000')).toBe(true);
    expect(options.responseOutputIds.size).toBe(20000);
    expect(options.responseOutputIds.has('call-0')).toBe(false);
    expect(options.responseOutputIds.has('call-20000')).toBe(true);
    expect(internals.codexSource(session, '/fixture-a', []).responseCallIds.size).toBe(20000);
    const reset = internals.codexSource(session, '/fixture-b', []);
    expect(reset.responseCallIds.size).toBe(0);
    expect(reset.responseOutputIds.size).toBe(0);
    expect(reset.toolSource).toBe('event_msg');
  });

  it('uses raw tools consistently in history and older pages without duplicating visual tools', () => {
    appendFileSync(file, call + output + visual);
    const history = manager.transcript(sessionId);
    const older = manager.transcriptBefore(sessionId, statSync(file).size, 8192).turns;
    expect(history.map((turn) => turn.kind)).toEqual(['tool_use', 'tool_result']);
    expect(older).toEqual(history);
  });

  it('keeps raw source across separate polling chunks', () => {
    const internals = manager as unknown as {
      startTurnWatch(sessionId: string, cwd: string, threadId: string): void;
      pollTurns(sessionId: string): void;
    };
    const emitted: Turn[] = [];
    manager.on('turn', (event: { turn: Turn }) => emitted.push(event.turn));
    internals.startTurnWatch(sessionId, home, THREAD);
    appendFileSync(file, call);
    internals.pollTurns(sessionId);
    appendFileSync(file, output);
    internals.pollTurns(sessionId);
    appendFileSync(file, visual);
    appendFileSync(
      file,
      row('event_msg', {
        type: 'item_completed',
        item: { type: 'FunctionCallOutput', id: 'fixture-call', output: 'duplicate' },
      }),
    );
    internals.pollTurns(sessionId);
    expect(emitted.map((turn) => turn.kind)).toEqual(['tool_use', 'tool_result']);
    appendFileSync(
      file,
      row('event_msg', {
        type: 'item_completed',
        item: { type: 'ImageView', id: 'independent', path: '/independent.png' },
      }),
    );
    internals.pollTurns(sessionId);
    expect(emitted.map((turn) => turn.toolUseId)).toEqual([
      'fixture-call',
      'fixture-call',
      'independent',
      'independent',
    ]);
    expect(manager.transcript(sessionId)).toEqual(emitted);
  });

  it('retains typed tools for visual-only rollouts', () => {
    appendFileSync(
      file,
      row('event_msg', {
        type: 'item_completed',
        item: { type: 'ImageView', id: 'image', path: '/fixture.png' },
      }),
    );
    expect(manager.transcript(sessionId).map((turn) => turn.kind)).toEqual([
      'tool_use',
      'tool_result',
    ]);
  });
});
