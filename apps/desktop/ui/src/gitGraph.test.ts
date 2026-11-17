import { describe, expect, it } from 'vitest';
import { layoutGraph } from './gitGraph';

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

describe('layoutGraph', () => {
  it('linear history stays on one lane', () => {
    const rows = layoutGraph([c('c3', 'c2'), c('c2', 'c1'), c('c1')]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.width)).toEqual([1, 1, 1]);
    // tip: no incoming edge, one outgoing; middle: in + out; root: in only
    expect(rows[0]?.segs.map((s) => s.kind)).toEqual(['out']);
    expect(rows[1]?.segs.map((s) => s.kind).sort()).toEqual(['in', 'out']);
    expect(rows[2]?.segs.map((s) => s.kind)).toEqual(['in']);
    // one color throughout
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
  });

  it('merge forks a second lane that converges at the shared ancestor', () => {
    // M merges B into the mainline: M→(A,B), B→A, A→root
    const rows = layoutGraph([c('M', 'A', 'B'), c('B', 'A'), c('A', 'root'), c('root')]);
    const [m, b, a] = rows;
    expect(m?.lane).toBe(0);
    expect(m?.merge).toBe(true);
    // merge row forks out to a second lane
    expect(m?.segs).toContainEqual(expect.objectContaining({ kind: 'out', from: 0, to: 1 }));
    // B sits on the forked lane while lane 0 passes through
    expect(b?.lane).toBe(1);
    expect(b?.segs).toContainEqual(expect.objectContaining({ kind: 'pass', from: 0, to: 0 }));
    // both lanes converge into A on lane 0, then the graph is single-lane
    expect(a?.lane).toBe(0);
    expect(a?.segs.filter((s) => s.kind === 'in')).toHaveLength(2);
    expect(rows[3]?.lane).toBe(0);
    expect(rows[3]?.width).toBe(1);
  });

  it('independent branch tips get their own lanes and colors', () => {
    // two unrelated tips (e.g. --all with main + feature), sharing no history
    const rows = layoutGraph([c('t1', 'p1'), c('t2', 'p2'), c('p1'), c('p2')]);
    expect(rows[0]?.lane).toBe(0);
    expect(rows[1]?.lane).toBe(1);
    expect(rows[0]?.color).not.toBe(rows[1]?.color);
    // p1 frees lane 0; p2 still lands on its own lane 1
    expect(rows[2]?.lane).toBe(0);
    expect(rows[3]?.lane).toBe(1);
  });

  it('a freed lane is reused by a later tip', () => {
    // t1/p1 occupy lane 0 and finish; t2 (listed after) reuses lane 0
    const rows = layoutGraph([c('t1', 'p1'), c('p1'), c('t2', 'p2'), c('p2')]);
    expect(rows[2]?.lane).toBe(0);
    // reused lane gets a fresh color — visually a new branch run
    expect(rows[2]?.color).not.toBe(rows[0]?.color);
  });

  it('merge into a lane that already expects the parent joins it', () => {
    // B and M both have parent A; M merges F whose parent is ALSO A:
    // M→(A,F) F→A ... A row must show F's lane joining, not a duplicate lane
    const rows = layoutGraph([c('M', 'A', 'F'), c('F', 'A'), c('A')]);
    // F was given lane 1 by the merge fork; F's own first parent A keeps lane 1
    expect(rows[1]?.lane).toBe(1);
    const a = rows[2];
    expect(a?.lane).toBe(0);
    expect(a?.segs.filter((s) => s.kind === 'in')).toHaveLength(2);
  });
});
