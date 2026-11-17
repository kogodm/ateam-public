import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HistoricalToolCard } from './HistoricalToolCard';

describe('HistoricalToolCard', () => {
  it('starts folded with readable input and an inert imported badge', () => {
    const html = renderToStaticMarkup(
      createElement(HistoricalToolCard, {
        name: 'Bash',
        input: 'cd /tmp\npython generate.py',
        label: 'Generate image',
      }),
    );
    expect(html).toContain('Imported');
    expect(html).toContain('Generate image');
    expect(html).toContain('cd /tmp\npython generate.py');
    expect(html).not.toContain('open=""');
    expect(html).not.toContain('sv-run-pulse');
    expect(html).not.toContain('(no output)');
  });

  it('renders orphan results as cards, not user bubbles, with file links', () => {
    const html = renderToStaticMarkup(
      createElement(HistoricalToolCard, {
        result: true,
        input: 'Done\n/tmp/result.png',
        onOpenPath: () => {},
      }),
    );
    expect(html).toContain('Tool result');
    expect(html).toContain('sv-historical-path');
    expect(html).not.toContain('sv-bubble');
    expect(html).not.toContain('>Input<');
  });

  it('escapes tool evidence rather than treating it as markup', () => {
    const html = renderToStaticMarkup(
      createElement(HistoricalToolCard, {
        input: '<script>alert(1)</script>',
        output: '<img src=x onerror=alert(1)>',
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });
});
