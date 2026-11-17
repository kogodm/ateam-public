import { renderToStaticMarkup } from 'react-dom/server';
import type { MarketSource } from '@ateam/contract';
import { describe, expect, it, vi } from 'vitest';
import {
  canConfirmSkillInstall,
  filterEnabledMarketSources,
  Market,
  skillCardTags,
  sourceRemovalNeedsConfirmation,
} from './Market';
import type { Rpc } from './rpc';

const rpc = { request: vi.fn() } as unknown as Rpc;

describe('Skill Market install confirmation', () => {
  it('opens on Skill Market without an implicit Human target selector', () => {
    const markup = renderToStaticMarkup(<Market rpc={rpc} onClose={vi.fn()} />);

    expect(markup).toContain('<h1 class="page-title">Skill Market</h1>');
    expect(markup).not.toContain('Add to');
    expect(markup).not.toContain('Choose a teammate');
  });

  it('keeps the market header above the independent results scroller', () => {
    const markup = renderToStaticMarkup(<Market rpc={rpc} onClose={vi.fn()} />);

    expect(markup).toContain('<main class="settings-body market-body">');
    expect(markup).toMatch(
      /<main class="settings-body market-body">[\s\S]*<div class="market-head">[\s\S]*?<\/div><div class="market-results">/,
    );
  });

  it('requires a selected existing Human and rejects confirmation while busy', () => {
    expect(canConfirmSkillInstall('', ['human-1'], false)).toBe(false);
    expect(canConfirmSkillInstall('human-1', [], false)).toBe(false);
    expect(canConfirmSkillInstall('human-1', ['human-1'], true)).toBe(false);
    expect(canConfirmSkillInstall('human-1', ['human-1'], false)).toBe(true);
  });

  it('requires a second explicit action before removing a source', () => {
    expect(sourceRemovalNeedsConfirmation('source-1', '')).toBe(true);
    expect(sourceRemovalNeedsConfirmation('source-1', 'source-1')).toBe(false);
    expect(sourceRemovalNeedsConfirmation('source-2', 'source-1')).toBe(true);
  });

  it('filters enabled sources and falls back to all when the selection is unavailable', () => {
    const sources: MarketSource[] = [
      { id: 'builtin', name: 'Built-in', kind: 'builtin', enabled: true },
      { id: 'remote-1', name: 'Remote One', kind: 'marketplace', enabled: true },
      { id: 'remote-2', name: 'Remote Two', kind: 'marketplace', enabled: false },
    ];

    expect(filterEnabledMarketSources(sources, 'all').map((source) => source.id)).toEqual([
      'builtin',
      'remote-1',
    ]);
    expect(filterEnabledMarketSources(sources, 'remote-1').map((source) => source.id)).toEqual([
      'remote-1',
    ]);
    expect(filterEnabledMarketSources(sources, 'remote-2').map((source) => source.id)).toEqual([
      'builtin',
      'remote-1',
    ]);
    expect(filterEnabledMarketSources(sources, 'removed').map((source) => source.id)).toEqual([
      'builtin',
      'remote-1',
    ]);
  });

  it('prioritizes category and shows no more than two non-duplicate tags', () => {
    expect(skillCardTags('Security', ['security', 'Audit', 'Docs', 'More'])).toEqual([
      'Security',
      'Audit',
      'Docs',
    ]);
    expect(skillCardTags(undefined, ['Build', 'Build', 'Review', 'More'])).toEqual([
      'Build',
      'Review',
    ]);
  });
});
