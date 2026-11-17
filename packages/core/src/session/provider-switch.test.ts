import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  continuationBundleText,
  continuationPrompt,
  writeContinuationBundle,
} from './provider-switch';

const dir = mkdtempSync(join(tmpdir(), 'ateam-provider-switch-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('provider-neutral session continuation', () => {
  const source = {
    providerId: 'claude' as const,
    model: 'opus',
    cwd: '/work/project',
    sessionName: 'migration',
    rawTranscriptPath: '/history/source.jsonl',
  };
  const turns = [
    { seq: 0, sessionId: 'old', role: 'user' as const, text: 'fix the importer', at: '' },
    {
      seq: 1,
      sessionId: 'old',
      role: 'assistant' as const,
      kind: 'thinking' as const,
      text: 'private scratch',
      at: '',
    },
    {
      seq: 2,
      sessionId: 'old',
      role: 'assistant' as const,
      kind: 'tool_use' as const,
      toolName: 'Edit',
      text: 'src/import.ts',
      at: '',
    },
  ];

  it('keeps user, assistant and tool state while omitting thinking', () => {
    const text = continuationBundleText(source, turns);
    expect(text).toContain('Source runtime: claude');
    expect(text).toContain('fix the importer');
    expect(text).toContain('assistant · Edit');
    expect(text).not.toContain('private scratch');
  });

  it('writes a private artifact and tells the target model to read it', () => {
    const path = writeContinuationBundle(source, turns, dir);
    expect(readFileSync(path, 'utf8')).toContain('/history/source.jsonl');
    const prompt = continuationPrompt(path, 'claude', 'codex');
    expect(prompt).toContain('claude -> codex');
    expect(prompt).toContain(path);
    expect(prompt).toContain('do not ask the user to restate');
  });
});
