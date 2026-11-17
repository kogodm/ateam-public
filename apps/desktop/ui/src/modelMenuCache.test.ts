import { describe, expect, it } from 'vitest';
import { cacheModelMenu, cleanModelLabel, readModelMenu } from './modelMenuCache';
import { parsePicker } from './tuiPicker';
function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}
describe('model menu cache', () => {
  it('only caches provider-specific first-level menus', () => {
    const store = storage();
    for (const title of [
      'Select Reasoning Level for gpt-5.6-sol',
      'Switch model?',
      'Enable full access?',
    ]) {
      cacheModelMenu('codex', parsePicker([title, '› 1. Yes', '  2. No']), store);
      expect(readModelMenu('codex', store)).toBeNull();
    }
    cacheModelMenu(
      'claude',
      parsePicker(['Select model', '❯ 1. Opus 5.5 (current) ✔', '  2. Sonnet (default)']),
      store,
    );
    expect(readModelMenu('claude', store)?.options).toEqual([
      { n: 1, label: 'Opus 5.5' },
      { n: 2, label: 'Sonnet' },
    ]);
    expect(readModelMenu('codex', store)).toBeNull();
    cacheModelMenu(
      'codex',
      parsePicker(['Select Model and Effort', '› 1. gpt-5.6-sol (current)', '  2. gpt-5.6-terra']),
      store,
    );
    expect(readModelMenu('codex', store)?.options[0]?.label).toBe('gpt-5.6-sol');
    expect(store.getItem('ateam.modelMenu.codex')).toContain('"at":');
  });
  it('cleans status suffixes but preserves meaningful parentheses', () => {
    expect(cleanModelLabel('Default (recommended) (default) ✔')).toBe('Default (recommended)');
    expect(cleanModelLabel('Opus 5.5 (current)')).toBe('Opus 5.5');
  });
  it('tolerates corrupt or unavailable storage', () => {
    expect(readModelMenu('claude', { getItem: () => '{' })).toBeNull();
    expect(readModelMenu('claude', { getItem: () => '{"options":[{}]}' })).toBeNull();
  });
});
