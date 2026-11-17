import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeModel } from './transcript-file';

/** claude stamps the model on every assistant record; /model is session-scoped
 *  and can change mid-conversation, so the LAST one is the truthful answer. */
describe('the model a claude session is actually on', () => {
  let home: string;
  let prev: string | undefined;
  const cwd = '/p/proj';
  const sid = 'sess-1';
  const write = (lines: string[]): void => {
    const dir = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    require('node:fs').mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sid}.jsonl`), lines.join('\n'));
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-model-'));
    prev = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prev ?? '';
    rmSync(home, { recursive: true, force: true });
  });

  it('takes the newest model, not the first', () => {
    write([
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8' } }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }),
    ]);
    expect(claudeModel(cwd, sid)).toBe('claude-opus-5');
  });

  it('skips the CLI\'s <synthetic> placeholder', () => {
    write([
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }),
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } }),
    ]);
    expect(claudeModel(cwd, sid)).toBe('claude-opus-5');
  });

  it('a session that has never answered has no model, and says so quietly', () => {
    write([JSON.stringify({ type: 'user', message: { content: 'hi' } })]);
    expect(claudeModel(cwd, sid)).toBe('');
  });

  it('a missing transcript never throws', () => {
    expect(claudeModel('/nope', 'nothing')).toBe('');
  });

  it('a half-written line at the chunk boundary is skipped, not fatal', () => {
    write([
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }),
      '{"message":{"model":"claude-op',
    ]);
    expect(claudeModel(cwd, sid)).toBe('claude-opus-5');
  });
});
