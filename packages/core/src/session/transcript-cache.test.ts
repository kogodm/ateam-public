import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeLastActiveAt, claudeSummary } from './transcript-file';

/**
 * session.list() derives a title and a last-active time for EVERY session on
 * every call, and the tree is refreshed once per restored session plus every
 * 5s forever. With 58 sessions that was ~38ms of synchronous transcript
 * reading per refresh — on the sidecar's only thread, competing with the PTY
 * output of the sessions being restored. The values are now memoised against
 * the file's mtime+size, which only helps if it invalidates exactly.
 */
const CWD = '/tmp/ateam-transcript-cache-spec';
const SESSION = 'sess-cache';

describe('transcript-derived values are memoised against the file', () => {
  let home: string;
  let prevHome: string | undefined;
  let file: string;

  const rec = (ts: string, text: string) =>
    JSON.stringify({
      type: 'user',
      timestamp: ts,
      message: { role: 'user', content: [{ type: 'text', text }] },
    });

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-tcache-spec-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    const dir = join(home, '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${SESSION}.jsonl`);
  });

  afterAll(() => {
    // biome-ignore lint/performance/noDelete: unsetting an env var is the point
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('returns the same answer while the transcript is untouched', () => {
    writeFileSync(file, `${rec('2026-08-25T01:00:00.000Z', 'first question')}\n`);
    const a = claudeLastActiveAt(CWD, SESSION);
    const b = claudeLastActiveAt(CWD, SESSION);
    expect(a).toBe('2026-08-25T01:00:00.000Z');
    expect(b).toBe(a);
    expect(claudeSummary(CWD, SESSION)).toBe('first question');
  });

  it('REGRESSION: an appended record is seen, not served from the cache', () => {
    // the whole point of the memo is that a growing transcript still reads
    // fresh — an append changes the size even inside one filesystem tick
    appendFileSync(file, `${rec('2026-08-25T02:30:00.000Z', 'later turn')}\n`);
    expect(claudeLastActiveAt(CWD, SESSION)).toBe('2026-08-25T02:30:00.000Z');
  });

  it('follows a rewrite that keeps the same length', () => {
    // same byte count, different content: mtime alone can land in the same
    // millisecond, so size is not the only guard that has to work
    writeFileSync(file, `${rec('2026-08-25T03:45:00.000Z', 'first question')}\n`);
    expect(claudeLastActiveAt(CWD, SESSION)).toBe('2026-08-25T03:45:00.000Z');
  });

  it('is empty for a transcript that does not exist, and picks it up later', () => {
    const MISSING = 'sess-not-yet';
    expect(claudeLastActiveAt(CWD, MISSING)).toBe('');
    const dir = join(home, '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
    writeFileSync(join(dir, `${MISSING}.jsonl`), `${rec('2026-08-25T04:00:00.000Z', 'hello')}\n`);
    // a miss must not be remembered — the session had simply not started yet
    expect(claudeLastActiveAt(CWD, MISSING)).toBe('2026-08-25T04:00:00.000Z');
  });
});
