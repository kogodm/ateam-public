import type { ProjectTree, SessionNode, SessionState, SessionStateAgent } from '@ateam/contract';
import { describe, expect, it } from 'vitest';
import { agentsToPersist } from './persistAgents';

const node = (id: string, state: SessionState, extra: Partial<SessionNode> = {}): SessionNode => ({
  sessionId: `pty-${id}-${state}`,
  projectId: 'p1',
  agentId: 'a1',
  agentName: 'Drawer',
  humanId: 'h1',
  humanName: 'Drawer',
  sessionName: 'art_by_ai',
  role: 'Art',
  workspaceId: 'w1',
  cwd: '/work/art_by_ai',
  claudeSessionId: id,
  state,
  providerId: 'codex',
  ...extra,
});
const tree = (...sessions: SessionNode[]): ProjectTree[] =>
  [{ projectId: 'p1', name: 'art_by_ai', sessions }] as unknown as ProjectTree[];
const saved = (id: string): SessionStateAgent => ({
  projectName: 'art_by_ai',
  agentName: 'Drawer',
  role: 'Art',
  dir: '/work/art_by_ai',
  claudeSessionId: id,
  directoryless: false,
  providerId: 'codex',
});
const ids = (a: SessionStateAgent[]): string[] => a.map((x) => x.claudeSessionId);

describe('agentsToPersist', () => {
  it('keeps a session whose resume failed at launch (exited tombstone)', () => {
    expect(ids(agentsToPersist(tree(node('lost', 'exited')), [saved('lost')]))).toEqual(['lost']);
  });

  it('keeps an exited session that was started this launch', () => {
    expect(ids(agentsToPersist(tree(node('new', 'exited')), []))).toEqual(['new']);
  });

  it('writes a conversation once, preferring the live row over its tombstone', () => {
    const out = agentsToPersist(
      tree(node('x', 'exited', { role: 'old' }), node('x', 'running', { role: 'new' })),
      [saved('x')],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('new');
  });

  it('never writes a handed-off session, and does not bring it back from boot', () => {
    const retired = node('old', 'exited', { replacedBySessionId: 'pty-new' });
    expect(ids(agentsToPersist(tree(retired, node('new', 'running')), [saved('old')]))).toEqual([
      'new',
    ]);
  });

  it('carries boot-saved sessions the tree does not have (not restored this time)', () => {
    expect(ids(agentsToPersist(tree(node('a', 'idle')), [saved('a'), saved('b')]))).toEqual([
      'a',
      'b',
    ]);
  });

  it('forgets a deleted session (gone from the tree and from remembered)', () => {
    expect(ids(agentsToPersist(tree(node('a', 'idle')), [saved('a')]))).toEqual(['a']);
  });
});
