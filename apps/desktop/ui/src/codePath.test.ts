import { describe, expect, it } from 'vitest';
import { codePath, codeUrl, markCodePaths } from './codePath';

describe('codePath', () => {
  it('takes absolute and folder-with-extension paths (color report, 09-18)', () => {
    expect(
      codePath('/Users/sample/PycharmProjects/demo1/experiments/photo2level/report.html'),
    ).toEqual({
      path: '/Users/sample/PycharmProjects/demo1/experiments/photo2level/report.html',
    });
    expect(codePath('~/projects/x/notes.md')).toEqual({ path: '~/projects/x/notes.md' });
    expect(codePath('apps/desktop/ui/src/StreamView.tsx:1434')).toEqual({
      path: 'apps/desktop/ui/src/StreamView.tsx',
      line: 1434,
    });
    expect(codePath('analysis/eval_20260918_multicast/')).toBeNull(); // no extension, relative
    expect(codePath('/tmp/out/')).toEqual({ path: '/tmp/out/' });
  });
  it('takes a web address too', () => {
    expect(codeUrl('http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(codeUrl('https://github.com/kogodm/ateam/releases/tag/v0.6.8')).toBeTruthy();
    expect(codeUrl('curl http://x')).toBeNull();
    expect(markCodePaths('<p><code>http://10.10.10.42:3456/ui</code></p>')).toContain(
      'class="sv-path"',
    );
  });
  it('leaves commands and code alone', () => {
    for (const s of [
      'npm run build',
      'a/b',
      'x.y',
      '/',
      'foo()',
      'git -c http.proxy=x push',
      'id/token',
    ])
      expect(codePath(s)).toBeNull();
  });
  it('marks only the path spans in rendered markdown, never a code block', () => {
    const html =
      '<p>see <code>/a/b/report.html</code> and <code>npm test</code></p><pre><code>/a/b.txt\n</code></pre>';
    expect(markCodePaths(html)).toBe(
      '<p>see <code class="sv-path" title="Open">/a/b/report.html</code> and <code>npm test</code></p><pre><code>/a/b.txt\n</code></pre>',
    );
  });
});
