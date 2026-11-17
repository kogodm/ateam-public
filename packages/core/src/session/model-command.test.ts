import { describe, expect, it } from 'vitest';
import { modelIdFromSetLine } from './model-command';

/** Real `/model` outputs from the transcripts on this machine — bold escapes,
 *  context suffixes, raw ids and all. */
const B = '\u001b[1m';
const N = '\u001b[22m';
const stdout = (s: string): string => `<local-command-stdout>${s}</local-command-stdout>`;

describe('the model a /model output names', () => {
  it('reads the plain case', () => {
    expect(modelIdFromSetLine(stdout('Set model to `Opus 5` and saved as your default'))).toBe(
      'claude-opus-5',
    );
  });

  it('sees through the bold escapes the CLI writes', () => {
    expect(modelIdFromSetLine(stdout(`Set model to ${B}Fable 5${N}`))).toBe('claude-fable-5');
  });

  it('drops the parentheticals', () => {
    expect(modelIdFromSetLine(stdout(`Set model to ${B}Opus 5 (1M context)${N}`))).toBe(
      'claude-opus-5',
    );
    expect(modelIdFromSetLine(stdout(`Set model to ${B}Opus 4.7 (1M context) (default)${N}`))).toBe(
      'claude-opus-4-7',
    );
  });

  it('keeps a dotted version the way an id spells it', () => {
    expect(modelIdFromSetLine(stdout('Set model to `Sonnet 4.6`'))).toBe('claude-sonnet-4-6');
    expect(modelIdFromSetLine(stdout('Set model to `Haiku 4.5`'))).toBe('claude-haiku-4-5');
  });

  it('passes a raw id through, minus its context suffix', () => {
    expect(modelIdFromSetLine(stdout('Set model to `claude-sonnet-4-6`'))).toBe(
      'claude-sonnet-4-6',
    );
    expect(modelIdFromSetLine(stdout('Set model to `claude-opus-4-7[1m]`'))).toBe(
      'claude-opus-4-7',
    );
  });

  it('says nothing about a label it cannot turn into an id', () => {
    expect(modelIdFromSetLine(stdout('Set model to `Default (recommended)`'))).toBe('');
  });

  it('ignores prose that merely mentions the phrase', () => {
    expect(modelIdFromSetLine('I will Set model to `Opus 5` for you')).toBe('');
    expect(modelIdFromSetLine(stdout('Kept model as `Opus 5`'))).toBe('');
  });

  it('ignores a message that only QUOTES a /model output', () => {
    const quoted = `the transcript then holds ${stdout('Set model to `Opus 5`')}, which we parse`;
    expect(modelIdFromSetLine(quoted)).toBe('');
  });
});
