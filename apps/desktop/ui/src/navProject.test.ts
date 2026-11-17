import { describe, expect, it } from 'vitest';
import {
  lastActiveSessionId,
  projectIdOfSession,
  projectsByRecency,
  resolveNavProject,
} from './navProject';

const P = (projectId: string, sessions: string[]) => ({ projectId, sessions });

describe('resolveNavProject', () => {
  const treeV1 = [P('repo-a', ['old']), P('repo-b', ['x'])];

  it('follows the focused session project', () => {
    expect(resolveNavProject({ tree: treeV1, focusedProjectId: 'repo-b' })?.projectId).toBe(
      'repo-b',
    );
  });

  it('the dropdown override beats focus', () => {
    expect(
      resolveNavProject({ tree: treeV1, focusedProjectId: 'repo-b', navProjectId: 'repo-a' })
        ?.projectId,
    ).toBe('repo-a');
  });

  it('holds the last project while focus is momentarily unresolvable', () => {
    expect(
      resolveNavProject({ tree: treeV1, focusedProjectId: undefined, lastProjectId: 'repo-b' })
        ?.projectId,
    ).toBe('repo-b');
  });

  it('REGRESSION: the fallback re-reads the current tree, never a stale snapshot', () => {
    // a handoff replaced 'old' with 'new' — the refreshed tree says so
    const treeV2 = [P('repo-a', ['new']), P('repo-b', ['x'])];
    const held = resolveNavProject({ tree: treeV1, focusedProjectId: 'repo-a' });
    expect(held?.sessions).toEqual(['old']);
    // focus is briefly unresolvable (successor not in `sessions` yet); the
    // fallback must still hand back the FRESH project, not the captured one
    const after = resolveNavProject({
      tree: treeV2,
      focusedProjectId: undefined,
      lastProjectId: 'repo-a',
    });
    expect(after?.sessions).toEqual(['new']);
    // identity must change too, or a downstream useMemo keyed on it stays pinned
    expect(after).not.toBe(held);
  });

  it('falls back to the first project when nothing resolves', () => {
    expect(resolveNavProject({ tree: treeV1, lastProjectId: 'gone' })?.projectId).toBe('repo-a');
    expect(resolveNavProject({ tree: [] })).toBeUndefined();
  });

  it("projectIdOfSession resolves through the TREE, not the session's own projectId", () => {
    const tree = [
      { projectId: '/repo/a', sessions: [{ sessionId: 's1', projectId: 'uuid-1' }] },
      { projectId: '/repo/b', sessions: [{ sessionId: 's2', projectId: 'uuid-2' }] },
    ];
    expect(projectIdOfSession(tree, 's2')).toBe('/repo/b');
    expect(projectIdOfSession(tree, 'nope')).toBeUndefined();
    // the bug: session.projectId is a uuid the tree never carries → tree[0]
    expect(resolveNavProject({ tree, focusedProjectId: 'uuid-2' })?.projectId).toBe('/repo/a');
    expect(
      resolveNavProject({ tree, focusedProjectId: projectIdOfSession(tree, 's2') })?.projectId,
    ).toBe('/repo/b');
  });
});

describe('lastActiveSessionId', () => {
  const S = (
    sessionId: string,
    lastActiveAt?: string,
    state = 'running',
    extra: Record<string, unknown> = {},
  ) => ({ sessionId, lastActiveAt, state, ...extra });

  it('picks the most recently active session', () => {
    expect(
      lastActiveSessionId([
        S('a', '2026-08-19T09:00:00Z'),
        S('b', '2026-08-19T11:00:00Z'),
        S('c', '2026-08-19T10:00:00Z'),
      ]),
    ).toBe('b');
  });

  it('prefers any live session over a more recent exited tombstone', () => {
    expect(
      lastActiveSessionId([
        S('dead', '2026-08-19T12:00:00Z', 'exited'),
        S('alive', '2026-08-19T08:00:00Z', 'hibernated'),
      ]),
    ).toBe('alive');
  });

  it('never targets a session replaced by a handoff successor', () => {
    expect(
      lastActiveSessionId([
        S('old', '2026-08-19T12:00:00Z', 'exited', { replacedBySessionId: 'new' }),
        S('new', '2026-08-19T11:00:00Z'),
      ]),
    ).toBe('new');
  });

  it('falls back to createdAt when activity was never recorded', () => {
    expect(
      lastActiveSessionId([
        { sessionId: 'older', createdAt: '2026-08-19T08:00:00Z', state: 'running' },
        { sessionId: 'newer', createdAt: '2026-08-19T10:00:00Z', state: 'running' },
      ]),
    ).toBe('newer');
  });

  it('returns undefined for an empty / fully-replaced project', () => {
    expect(lastActiveSessionId([])).toBeUndefined();
    expect(lastActiveSessionId([S('x', undefined, 'exited', { replacedBySessionId: 'y' })])).toBeUndefined();
  });
});

describe('projectsByRecency', () => {
  /** project with sessions given as [lastActiveAt, ...] */
  const PR = (projectId: string, ats: (string | undefined)[]) => ({
    projectId,
    sessions: ats.map((lastActiveAt, i) => ({ sessionId: `${projectId}-${i}`, lastActiveAt })),
  });
  const ids = (tree: { projectId: string }[]) => tree.map((p) => p.projectId);

  it('puts the most recently active project first', () => {
    const tree = [
      PR('stale', ['2026-08-01T10:00:00.000Z']),
      PR('freshest', ['2026-08-20T09:00:00.000Z']),
      PR('middle', ['2026-08-14T22:00:00.000Z']),
    ];
    expect(ids(projectsByRecency(tree))).toEqual(['freshest', 'middle', 'stale']);
  });

  it('ranks a project by its NEWEST session, not its first', () => {
    const tree = [
      PR('a', ['2026-08-19T00:00:00.000Z']),
      PR('b', ['2026-08-01T00:00:00.000Z', '2026-08-20T00:00:00.000Z']),
    ];
    expect(ids(projectsByRecency(tree))).toEqual(['b', 'a']);
  });

  it('ignores a session superseded by a handoff successor', () => {
    const tree = [
      PR('live', ['2026-08-10T00:00:00.000Z']),
      {
        projectId: 'retired',
        sessions: [
          {
            sessionId: 'r0',
            lastActiveAt: '2026-08-20T00:00:00.000Z',
            replacedBySessionId: 'r1',
          },
        ],
      },
    ];
    expect(ids(projectsByRecency(tree))).toEqual(['live', 'retired']);
  });

  it('sorts projects with no activity last, keeping their relative order', () => {
    const tree = [PR('empty-1', []), PR('busy', ['2026-08-20T00:00:00.000Z']), PR('empty-2', [])];
    expect(ids(projectsByRecency(tree))).toEqual(['busy', 'empty-1', 'empty-2']);
  });

  it('does not reorder the caller\'s array (the sidebar keeps tree order)', () => {
    const tree = [PR('a', ['2026-08-01T00:00:00.000Z']), PR('b', ['2026-08-20T00:00:00.000Z'])];
    projectsByRecency(tree);
    expect(ids(tree)).toEqual(['a', 'b']);
  });
});
