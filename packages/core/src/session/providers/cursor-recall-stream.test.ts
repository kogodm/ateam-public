import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readCursorMigrationMessages,
  readCursorStreamPage,
  writeCursorSessionImport,
} from './cursor-session-import';
import { wrapCursorRecall } from './cursor-recall';

let root = '';

afterEach(() => {
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('Cursor recall hidden in stream / migration', () => {
  it('strips a recall-only user turn from the stream page', () => {
    root = mkdtempSync(join(tmpdir(), 'ateam-cursor-recall-stream-'));
    vi.stubEnv('CURSOR_CONFIG_DIR', join(root, 'cursor'));
    const cwd = join(root, 'project');
    const imported = writeCursorSessionImport(
      [
        {
          role: 'user',
          text: wrapCursorRecall('You are Weber. Skills: foo.'),
          at: '2026-11-18T00:00:00.000Z',
        },
        { role: 'assistant', text: 'Ready.', at: '2026-11-18T00:00:01.000Z' },
      ],
      cwd,
    );
    const page = readCursorStreamPage(imported.path, 'sess');
    expect(page.turns.filter((turn) => turn.role === 'user')).toEqual([]);
    expect(page.turns.some((turn) => turn.role === 'assistant' && turn.text === 'Ready.')).toBe(
      true,
    );
  });

  it('keeps the real user text when recall is prepended', () => {
    root = mkdtempSync(join(tmpdir(), 'ateam-cursor-recall-stream-'));
    vi.stubEnv('CURSOR_CONFIG_DIR', join(root, 'cursor'));
    const cwd = join(root, 'project');
    const imported = writeCursorSessionImport(
      [
        {
          role: 'user',
          text: `${wrapCursorRecall('skills index')}\n\nContinue from the latest request.`,
          at: '2026-11-18T00:00:00.000Z',
        },
        { role: 'assistant', text: 'On it.', at: '2026-11-18T00:00:01.000Z' },
      ],
      cwd,
    );
    const page = readCursorStreamPage(imported.path, 'sess');
    expect(page.turns.filter((turn) => turn.role === 'user').map((turn) => turn.text)).toEqual([
      'Continue from the latest request.',
    ]);
    expect(readCursorMigrationMessages(imported.path).map((message) => message.text)).toEqual([
      'Continue from the latest request.',
      'On it.',
    ]);
  });

  it('also strips recall nested inside <user_query>', () => {
    root = mkdtempSync(join(tmpdir(), 'ateam-cursor-recall-stream-'));
    vi.stubEnv('CURSOR_CONFIG_DIR', join(root, 'cursor'));
    const cwd = join(root, 'project');
    const imported = writeCursorSessionImport(
      [
        {
          role: 'user',
          text: `<user_query>\n${wrapCursorRecall('skills')}\n\nShip the fix.\n</user_query>`,
          at: '2026-11-18T00:00:00.000Z',
        },
      ],
      cwd,
    );
    const page = readCursorStreamPage(imported.path, 'sess');
    expect(page.turns.filter((turn) => turn.role === 'user').map((turn) => turn.text)).toEqual([
      'Ship the fix.',
    ]);
  });
});
