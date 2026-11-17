import type { SessionStateAgent } from '@ateam/contract';
import { describe, expect, it } from 'vitest';
import { orderForRestore } from './restoreOrder';

const mk = (id: string, name = id): SessionStateAgent => ({
  projectName: `proj-${name}`,
  agentName: name,
  role: 'coder',
  dir: `/tmp/${name}`,
  claudeSessionId: id,
});

describe('orderForRestore', () => {
  it('places the focus id first', () => {
    const saved = [mk('a'), mk('b'), mk('c')];
    const out = orderForRestore(saved, 'b');
    expect(out.map((a) => a.claudeSessionId)).toEqual(['b', 'a', 'c']);
  });

  it('uses saved[0] as priority when focus id is absent', () => {
    const saved = [mk('a'), mk('b'), mk('c')];
    const out = orderForRestore(saved, 'missing');
    expect(out.map((a) => a.claudeSessionId)).toEqual(['a', 'b', 'c']);
  });

  it('uses saved[0] as priority when no focus id is given', () => {
    const saved = [mk('a'), mk('b')];
    const out = orderForRestore(saved);
    expect(out.map((a) => a.claudeSessionId)).toEqual(['a', 'b']);
  });

  it('preserves saved order for the rest (last-used-desc proxy)', () => {
    const saved = [mk('a'), mk('b'), mk('c'), mk('d')];
    const out = orderForRestore(saved, 'c');
    expect(out.map((a) => a.claudeSessionId)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('returns [] for empty input', () => {
    expect(orderForRestore([], 'x')).toEqual([]);
  });

  it('handles a single element', () => {
    const saved = [mk('only')];
    expect(orderForRestore(saved).map((a) => a.claudeSessionId)).toEqual([
      'only',
    ]);
  });
});
