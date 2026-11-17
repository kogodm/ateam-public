import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { estimateTokensFromTranscript } from './token-estimate';

/**
 * The Status panel used to flip between two numbers for one session: the real
 * context (247K, grey) and roughly three times it (724K, red bar + spurious
 * auto-handoff prompts). The high one was the bytes/30 fallback, reached
 * whenever the newest usage-bearing record happened to be a `<synthetic>` turn
 * whose usage block is all zeros.
 */
const CWD = '/tmp/ateam-token-estimate-spec';
const SESSION = 'sess-1';

const assistantTurn = (cacheRead: number, cacheCreate: number) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
        output_tokens: 40,
      },
    },
  });

/** What claude writes for an interrupt / "No response requested" / API error. */
const syntheticTurn = () =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: {
      model: '<synthetic>',
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  });

/** A Task/subagent turn: its own, much smaller context. */
const sidechainTurn = (cacheRead: number) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheRead,
        output_tokens: 10,
      },
    },
  });

/** Pad the file so the bytes/30 fallback would be conspicuously wrong. */
const padding = () => JSON.stringify({ type: 'user', message: { content: 'x'.repeat(200_000) } });

describe('context estimate from a claude transcript', () => {
  let home: string;
  let dir: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-token-spec-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CODEX_HOME', join(home, '.codex'));
    dir = join(home, '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const write = (...lines: string[]) =>
    writeFileSync(join(dir, `${SESSION}.jsonl`), `${lines.join('\n')}\n`);

  const estimate = () => estimateTokensFromTranscript(CWD, SESSION).tokens;

  it('sums input + cache_creation + cache_read of the newest turn', () => {
    write(padding(), assistantTurn(240_000, 1_000), assistantTurn(247_000, 589));
    expect(estimate()).toBe(2 + 589 + 247_000);
  });

  it('walks past a trailing <synthetic> turn instead of falling back to bytes/30', () => {
    write(padding(), assistantTurn(247_000, 589), syntheticTurn());
    expect(estimate()).toBe(2 + 589 + 247_000);
  });

  it('ignores a subagent turn — that is not this conversation context', () => {
    write(padding(), assistantTurn(247_000, 589), sidechainTurn(12_000));
    expect(estimate()).toBe(2 + 589 + 247_000);
  });

  it('falls back to bytes/30 only when no turn has spent tokens yet', () => {
    write(padding(), syntheticTurn());
    const { tokens, bytes } = estimateTokensFromTranscript(CWD, SESSION);
    expect(tokens).toBe(Math.floor(bytes / 30));
  });

  it('looks past megabytes of trailing pictures instead of guessing from bytes', () => {
    // two Reads of image sheets: ~2.5MB of base64 after the newest turn
    const picture = () =>
      JSON.stringify({ type: 'user', message: { content: 'A'.repeat(1_250_000) } });
    write(padding(), assistantTurn(439_750, 2_502), picture(), picture());
    const r = estimateTokensFromTranscript(CWD, SESSION);
    expect(r.tokens).toBe(2 + 2_502 + 439_750);
    expect(r.estimated).toBeUndefined();
  });

  it('says so when the number is only the bytes/30 guess', () => {
    write(padding(), syntheticTurn());
    expect(estimateTokensFromTranscript(CWD, SESSION).estimated).toBe(true);
  });

  it('reports 0 for a session with no transcript on disk', () => {
    expect(estimateTokensFromTranscript(CWD, 'never-started').tokens).toBe(0);
  });

  // Claude's own auto-compaction (2.1.30x) writes a boundary and a summary and
  // then NO usage record until the next reply. Until then the last usage is the
  // pre-compaction one, so the panel kept showing ~225K for a context that was
  // 11K, and the auto-handoff / experience checkpoint read the same stale number.
  const boundary = (postTokens?: number) =>
    JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      compactMetadata: {
        trigger: 'auto',
        preTokens: 224_777,
        ...(postTokens ? { postTokens } : {}),
      },
    });
  const summary = () =>
    JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      message: { content: 'This session is being continued from a previous conversation' },
    });

  it('reads the context after a native compaction from the boundary, not the stale turn', () => {
    write(padding(), assistantTurn(224_000, 600), boundary(11_343), summary());
    expect(estimate()).toBe(11_343);
  });

  it('goes back to real usage once a reply follows the compaction', () => {
    write(
      padding(),
      assistantTurn(224_000, 600),
      boundary(11_343),
      summary(),
      assistantTurn(80_000, 1_200),
    );
    expect(estimate()).toBe(2 + 1_200 + 80_000);
  });

  it('does not read tool text that merely mentions compact_boundary as one', () => {
    const mention = JSON.stringify({
      type: 'user',
      message: { content: '{"subtype":"compact_boundary","compactMetadata":{"postTokens":5}}' },
    });
    write(padding(), assistantTurn(224_000, 600), mention);
    expect(estimate()).toBe(2 + 600 + 224_000);
  });

  it('keeps the last usage when a boundary carries no postTokens', () => {
    write(padding(), assistantTurn(224_000, 600), boundary(), summary());
    expect(estimate()).toBe(2 + 600 + 224_000);
  });
});

describe('context estimate from a Codex rollout', () => {
  let home: string;
  let directory: string;
  const sessionId = randomUUID();

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-codex-token-spec-'));
    const codexHome = join(home, 'isolated-codex');
    vi.stubEnv('HOME', home);
    vi.stubEnv('CODEX_HOME', codexHome);
    directory = join(codexHome, 'sessions', '2026', '10', '09');
    mkdirSync(directory, { recursive: true });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const write = (...records: string[]) =>
    writeFileSync(join(directory, `rollout-test-${sessionId}.jsonl`), `${records.join('\n')}\n`);
  const estimate = () => estimateTokensFromTranscript(CWD, sessionId, 'codex');
  const tokenCount = (input: unknown, total: unknown, window: unknown = 258_400) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: window,
          last_token_usage: {
            input_tokens: input,
            total_tokens: total,
            cached_input_tokens: 90_000,
          },
          total_token_usage: { input_tokens: 9_000_000, total_tokens: 10_000_000 },
        },
      },
    });
  const largeOutput = (size: number) =>
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call_output', output: 'x'.repeat(size) },
    });
  const boundaries = [JSON.stringify({ type: 'compacted', payload: { replacement_history: [] } })];

  it('uses latest input without adding cached, output or cumulative tokens', () => {
    write(tokenCount(100_000, 120_000), tokenCount(216_249, 220_000));
    expect(estimate()).toMatchObject({ tokens: 216_249, contextWindow: 258_400 });
    expect(estimate().estimated).toBeUndefined();
  });

  it.each(boundaries)('uses positive last total after zero input following %s', (boundary) => {
    write(tokenCount(216_249, 220_000), boundary, tokenCount(0, 12_345));
    expect(estimate()).toMatchObject({ tokens: 12_345, contextWindow: 258_400 });
    expect(estimate().estimated).toBeUndefined();
  });

  it.each(boundaries)('does not reuse usage before %s', (boundary) => {
    write(tokenCount(216_249, 220_000), boundary, largeOutput(100));
    const result = estimate();
    expect(result.estimated).toBe(true);
    expect(result.tokens).toBe(Math.floor(result.bytes / 30));
    expect(result.contextWindow).toBeUndefined();
  });

  it('requires both event_msg and token_count record types', () => {
    const valid = JSON.parse(tokenCount(99_999, 100_000));
    write(
      JSON.stringify({ ...valid, type: 'response_item' }),
      JSON.stringify({ ...valid, payload: { ...valid.payload, type: 'other' } }),
      JSON.stringify({ type: 'assistant', usage: { input_tokens: 98_000 } }),
    );
    expect(estimate().estimated).toBe(true);
    expect(estimate().contextWindow).toBeUndefined();
  });

  it('never substitutes cumulative usage when last usage is absent', () => {
    const record = JSON.parse(tokenCount(100, 200));
    record.payload.info.last_token_usage = undefined;
    write(JSON.stringify(record));
    expect(estimate()).toMatchObject({ estimated: true, contextWindow: 258_400 });
  });

  it.each([undefined, null, '100', -1, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid input and total tokens: %s',
    (invalid) => {
      write(tokenCount(invalid, invalid));
      expect(estimate().estimated).toBe(true);
    },
  );

  it.each([null, '100', -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not mask malformed input with total tokens: %s',
    (invalid) => {
      write(tokenCount(invalid, 12_345));
      expect(estimate().estimated).toBe(true);
    },
  );

  it.each([null, '258400', 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'omits invalid context window: %s',
    (invalid) => {
      write(tokenCount(12_345, 13_000, invalid));
      expect(estimate().tokens).toBe(12_345);
      expect(estimate().contextWindow).toBeUndefined();
    },
  );

  it('rejects numeric overflow parsed from valid JSON', () => {
    write(tokenCount(1, 1, 1).replaceAll(':1', ':1e999'));
    expect(estimate().estimated).toBe(true);
    expect(estimate().contextWindow).toBeUndefined();
  });

  it.each([300_000, 4_300_000])('widens the tail past %i bytes of tool output', (size) => {
    write(tokenCount(123_456, 130_000), largeOutput(size));
    expect(estimate()).toMatchObject({ tokens: 123_456, contextWindow: 258_400 });
    expect(estimate().estimated).toBeUndefined();
  });

  it.each(boundaries)('stops at %s after widening beyond 4MB', (boundary) => {
    write(tokenCount(216_249, 220_000), boundary, largeOutput(4_300_000));
    expect(estimate().estimated).toBe(true);
    expect(estimate().contextWindow).toBeUndefined();
  });

  it('does not mistake tool text for a compaction boundary', () => {
    write(
      tokenCount(123_456, 130_000),
      JSON.stringify({ type: 'response_item', payload: { type: 'context_compacted' } }),
    );
    expect(estimate().tokens).toBe(123_456);
  });

  it('ignores malformed trailing records', () => {
    write(tokenCount(123_456, 130_000), '{"type":"event_msg","payload":{"type":"token_count"');
    expect(estimate().tokens).toBe(123_456);
  });

  it('retains post-compaction usage before the context_compacted completion event', () => {
    write(
      tokenCount(216_249, 220_000),
      JSON.stringify({ type: 'compacted', payload: { replacement_history: [] } }),
      tokenCount(0, 17_435),
      JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
    );
    expect(estimate()).toMatchObject({ tokens: 17_435, contextWindow: 258_400 });
    expect(estimate().estimated).toBeUndefined();
  });

  it('still estimates when compaction has no new usage before its completion event', () => {
    write(
      tokenCount(216_249, 220_000),
      JSON.stringify({ type: 'compacted', payload: { replacement_history: [] } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
    );
    expect(estimate().estimated).toBe(true);
  });

  it('accepts legacy last usage with total_tokens but no input_tokens', () => {
    write(tokenCount(undefined, 17_435));
    expect(estimate()).toMatchObject({ tokens: 17_435, contextWindow: 258_400 });
    expect(estimate().estimated).toBeUndefined();
  });

  it('stops searching beyond 16MB', () => {
    write(tokenCount(123_456, 130_000), largeOutput(16 * 1024 * 1024 + 100));
    expect(estimate().estimated).toBe(true);
  });
});
