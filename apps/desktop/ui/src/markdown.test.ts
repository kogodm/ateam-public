import { describe, expect, it } from 'vitest';
import { marked } from './markdown';

const render = (source: string) => marked.parse(source, { async: false });

describe('shared Markdown rendering', () => {
  it('does not strike out text between numeric ranges', () => {
    expect(render('色板约 20~30 色。大约 5~10')).toBe('<p>色板约 20~30 色。大约 5~10</p>\n');
    expect(render('20-30 色，5-10')).not.toContain('<del>');
  });
  it('requires double tildes for explicit strikethrough', () => {
    expect(render('~普通文字~')).toBe('<p>~普通文字~</p>\n');
    expect(render('~~删除 **旧内容**~~')).toContain('<del>删除 <strong>旧内容</strong></del>');
    expect(render('20~30，~~旧~~，5~10')).toContain('20~30，<del>旧</del>，5~10');
  });
  it('preserves lists, rules, code fences and inline code', () => {
    expect(render('- first\n- second')).toContain('<li>first</li>');
    expect(render('---')).toContain('<hr>');
    expect(render('`20~30`')).toContain('<code>20~30</code>');
    expect(render('~~~text\n20~30\n~~~')).toContain('<code class="language-text">20~30\n</code>');
  });
  it('uses the same rule while tokenizing picture-separated markdown', () => {
    const tokens = marked.lexer('20~30 色，5~10');
    expect(marked.parser(tokens)).not.toContain('<del>');
  });
});
