import { describe, expect, it } from 'vitest';
import { plainLine } from './plainLine';

describe('plainLine', () => {
  it("drops a tool's emoji and keeps its words (09-23)", () => {
    expect(plainLine('⚡ Done in 14ms')).toBe('Done in 14ms');
  });
  it('drops composed emoji whole — no stray joiners or selectors left', () => {
    expect(plainLine('✅️ ok 👨‍💻 built 🇨🇳 cn')).toBe('ok built cn');
  });
  it('leaves text, CJK, numbers and symbols that are not pictographs alone', () => {
    expect(plainLine('[.66-240] 进度 46/240 · 21% → ok ✓ #3 *')).toBe(
      '[.66-240] 进度 46/240 · 21% → ok ✓ #3 *',
    );
  });
});
