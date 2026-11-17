import { describe, expect, it } from 'vitest';
import { projectStatus } from './projectStatus';

const base = {
  focused: 'f',
  pendingMenu: new Set<string>(),
  unread: new Set<string>(),
  tokenEst: new Map<string, number>(),
  threshold: 100,
  lastOutput: new Map<string, number>(),
  now: 10_000,
};
const ss = [
  { sessionId: 'f', state: 'running' },
  { sessionId: 'a', state: 'running' },
  { sessionId: 'b', state: 'hibernated' },
];

describe('projectStatus (#20)', () => {
  it('ranks menu > limit > attn > busy > nothing, ignoring the focused session', () => {
    expect(projectStatus(ss, base)).toBeUndefined();
    expect(projectStatus(ss, { ...base, lastOutput: new Map([['a', 9_800]]) })).toBe('busy');
    expect(projectStatus(ss, { ...base, unread: new Set(['b']), lastOutput: new Map([['a', 9_800]]) })).toBe('attn');
    expect(projectStatus(ss, { ...base, unread: new Set(['b']), tokenEst: new Map([['a', 100]]) })).toBe('limit');
    expect(projectStatus(ss, { ...base, pendingMenu: new Set(['a']), tokenEst: new Map([['b', 100]]) })).toBe('menu');
    // only the focused session has signals → nothing
    expect(projectStatus(ss, { ...base, pendingMenu: new Set(['f']), unread: new Set(['f']) })).toBeUndefined();
  });
});
