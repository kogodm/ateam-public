import { describe, expect, it } from 'vitest';
import { filterTree, normalizeQuery } from './treeSearch';

interface S {
  id: string;
  name?: string;
  project?: string;
}
const byProject = [
  {
    key: 'p1',
    name: 'TrixMahjong',
    sessions: [
      { id: 'a', name: '关卡生成', project: 'TrixMahjong' },
      { id: 'b', name: 'UI 截图', project: 'TrixMahjong' },
    ],
  },
  {
    key: 'p2',
    name: 'ATeam',
    alias: '桌面端',
    sessions: [{ id: 'c', name: '调研', project: 'ATeam' }],
  },
  { key: 'p3', name: 'Tipsy', sessions: [{ id: 'd', name: 'story catalog', project: 'Tipsy' }] },
];
const name = (s: S) => s.name;
const project = (s: S) => [s.project];

describe('filterTree', () => {
  it('shows everything when not searching', () => {
    expect(filterTree(byProject, '   ', name, project, true)).toHaveLength(3);
  });

  it('a project-name match keeps the whole project', () => {
    const r = filterTree(byProject, 'trix', name, project, true);
    expect(r.map((g) => g.key)).toEqual(['p1']);
    expect(r[0]?.sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('matches a project by its display alias too', () => {
    expect(filterTree(byProject, '桌面', name, project, true).map((g) => g.key)).toEqual(['p2']);
  });

  it('a session-name match keeps only that session, inside its project', () => {
    const r = filterTree(byProject, '截图', name, project, true);
    expect(r.map((g) => g.key)).toEqual(['p1']);
    expect(r[0]?.sessions.map((s) => s.id)).toEqual(['b']);
  });

  it('is case-insensitive and ignores surrounding spaces', () => {
    expect(filterTree(byProject, '  STORY ', name, project, true).map((g) => g.key)).toEqual([
      'p3',
    ]);
  });

  it("in the Humans view a person is not a project, but each session's project still counts", () => {
    const byHuman = [
      {
        key: 'h1',
        name: 'Weber',
        sessions: [
          { id: 'c', name: '调研', project: 'ATeam' },
          { id: 'd', name: 'x', project: 'Tipsy' },
        ],
      },
    ];
    expect(filterTree(byHuman, 'weber', name, project, false)).toEqual([]);
    const r = filterTree(byHuman, 'tipsy', name, project, false);
    expect(r[0]?.sessions.map((s) => s.id)).toEqual(['d']);
  });

  it('drops groups with nothing left', () => {
    expect(filterTree(byProject, 'nothing-like-this', name, project, true)).toEqual([]);
  });
});

describe('normalizeQuery', () => {
  it('trims and lowercases', () => {
    expect(normalizeQuery('  AbC ')).toBe('abc');
  });
});
