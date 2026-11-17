import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EDITABLE_PROMPTS,
  PROMPT_MAX_CHARS,
  getPrompt,
  listPrompts,
  placeholdersIn,
  promptOverrideDir,
  resetPromptOverride,
  setPromptOverride,
} from './prompts';

describe('prompt overrides', () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-prompts-spec-'));
    prev = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) Reflect.deleteProperty(process.env, 'ATEAM_HOME');
    else process.env.ATEAM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it('serves the bundled default until the user saves an override', () => {
    const before = getPrompt('codegraphHint');
    expect(before).toContain('codegraph');
    setPromptOverride('codegraphHint', 'use the graph, not grep');
    expect(getPrompt('codegraphHint')).toBe('use the graph, not grep');
  });

  it('applies on the very next call — no cache between the file and the prompt', () => {
    setPromptOverride('recallPreamble', 'one');
    expect(getPrompt('recallPreamble')).toBe('one');
    setPromptOverride('recallPreamble', 'two');
    expect(getPrompt('recallPreamble')).toBe('two');
  });

  it('reset goes back to the default and removes the file', () => {
    const def = getPrompt('recallPreamble');
    setPromptOverride('recallPreamble', 'custom');
    resetPromptOverride('recallPreamble');
    expect(getPrompt('recallPreamble')).toBe(def);
    expect(existsSync(join(promptOverrideDir(), 'recallPreamble.txt'))).toBe(false);
    expect(() => resetPromptOverride('recallPreamble')).not.toThrow(); // already default
  });

  it('substitutes as before, including a language rule the user overrode', () => {
    setPromptOverride('lang', 'Always answer in French.');
    setPromptOverride('summarize', 'Profile. {{LANG_RULE}}');
    expect(getPrompt('summarize')).toBe('Profile. Always answer in French.');
    setPromptOverride('delegation', 'docs live in {{DOCS_DIR}}');
    expect(getPrompt('delegation', { DOCS_DIR: '/p/docs' })).toBe('docs live in /p/docs');
  });

  it('reports the placeholders an edit dropped, and still saves it', () => {
    const r = setPromptOverride('handoff', 'write the doc. {{META_DIR}}');
    expect(r.missingPlaceholders).toEqual(['FOCUS_HINT', 'LANG_RULE', 'SIZE_RULE', 'SIZE_STATUS']);
    expect(getPrompt('handoff')).toBe('write the doc. {{META_DIR}}');
  });

  it('lists every editable prompt with its state, and never the dead one', () => {
    setPromptOverride('delegation', 'x');
    const list = listPrompts();
    expect(list.map((p) => p.name)).toEqual(Object.keys(EDITABLE_PROMPTS));
    expect(list.some((p) => (p.name as string) === 'record')).toBe(false);
    const d = list.find((p) => p.name === 'delegation');
    expect(d?.customized).toBe(true);
    expect(d?.text).toBe('x');
    expect(d?.defaultText).toContain('{{DOCS_DIR}}');
    expect(d?.placeholders).toEqual(['DOCS_DIR']);
    expect(list.find((p) => p.name === 'handoff')?.customized).toBe(false);
  });

  it('refuses names it does not edit, and runaway sizes', () => {
    expect(() => setPromptOverride('record', 'x')).toThrow(/not an editable prompt/);
    expect(() => setPromptOverride('../config', 'x')).toThrow(/not an editable prompt/);
    expect(() => setPromptOverride('lang', 'x'.repeat(PROMPT_MAX_CHARS + 1))).toThrow(/too long/);
  });
});

describe('placeholdersIn', () => {
  it('finds each placeholder once, sorted', () => {
    expect(placeholdersIn('{{B}} {{A}} {{B}} {not} {{lower}}')).toEqual(['A', 'B']);
  });
});
