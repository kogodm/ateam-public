import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiffView } from './StreamView';

describe('native file change display', () => {
  it('renders file totals, original line numbers, and escaped code', () => {
    const html = renderToStaticMarkup(
      createElement(DiffView, {
        patch: [
          {
            file: 'contracts.py',
            hunks: [
              { oldStart: 4, newStart: 4, lines: ['-VERSION = 2', '+VERSION = 3', '+<script>'] },
            ],
          },
        ],
        onOpenFile: () => {},
      }),
    );
    expect(html).toContain('contracts.py (+2 -1)');
    expect(html).toContain('sv-diff-line add');
    expect(html).toContain('sv-diff-line del');
    expect(html).toContain('sv-diff-no">4</span>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('marks bounded previews as partial', () => {
    const html = renderToStaticMarkup(
      createElement(DiffView, {
        patch: [
          {
            file: 'large.ts',
            hunks: [{ oldStart: 0, newStart: 1, lines: ['+first'] }],
            dropped: 9,
          },
        ],
      }),
    );
    expect(html).toContain('(+1 -0, partial)');
    expect(html).toContain('9 more lines');
  });
});
