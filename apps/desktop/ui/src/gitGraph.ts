/**
 * Commit-graph lane layout for the Panel's git log — the pure math behind the
 * branch-tree rendering (PanelGit draws the result as one small SVG per row).
 *
 * Input: commits newest-first in TOPO order (gitLog passes --topo-order, so a
 * child always appears before its parents). Classic lane algorithm: each lane
 * carries the hash it is "waiting for"; a commit lands on the first lane
 * expecting it (or a free lane for branch tips), extra expectants converge in,
 * and each parent either joins a lane that already expects it or claims one.
 *
 * Lanes are NOT compacted after they free up — a freed lane is simply reused
 * by the next allocation. This keeps long-lived branches visually stable
 * (the same branch stays in the same column) at the cost of a slightly wider
 * graph, which the renderer caps anyway.
 */

export interface GraphSeg {
  /** lane index at the segment's origin (top edge, or the node for 'out') */
  from: number;
  /** lane index at the segment's destination (node for 'in', bottom edge for 'out') */
  to: number;
  /** 'pass' = unrelated lane crossing the whole row; 'in' = edge entering
   *  this row's node from the top; 'out' = edge leaving the node downward. */
  kind: 'pass' | 'in' | 'out';
  /** palette index (stable per lane run) */
  color: number;
}

export interface GraphRow {
  /** lane the commit node sits on */
  lane: number;
  /** node's palette index */
  color: number;
  /** true when the commit has 2+ parents (rendered as a hollow ring) */
  merge: boolean;
  segs: GraphSeg[];
  /** lanes this row actually touches (for renderer width) */
  width: number;
}

export const GRAPH_PALETTE = [
  '#6aa8e0', // blue (matches --accent)
  '#5ed188', // green
  '#d9c15c', // yellow
  '#b085c9', // purple
  '#e08a8a', // red
  '#5ec9c9', // teal
  '#d99a5c', // orange
  '#8a93e0', // indigo
] as const;

export function layoutGraph(
  commits: readonly { hash: string; parents: readonly string[] }[],
): GraphRow[] {
  const lanes: (string | null)[] = []; // hash each lane is waiting for
  const laneColor: number[] = [];
  let nextColor = 0;
  const claim = (hash: string | null, freshColor: boolean): number => {
    let i = lanes.indexOf(null);
    if (i < 0) {
      i = lanes.length;
      lanes.push(null);
      laneColor.push(0);
    }
    lanes[i] = hash;
    if (freshColor) laneColor[i] = nextColor++ % GRAPH_PALETTE.length;
    return i;
  };

  const rows: GraphRow[] = [];
  for (const c of commits) {
    const segs: GraphSeg[] = [];
    const matching: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === c.hash) matching.push(i);
    }
    // node lane: first expectant, else a free lane (branch tip → new color)
    const lane = matching.length > 0 ? (matching[0] as number) : claim(null, true);
    const color = laneColor[lane] ?? 0;

    // top half: every occupied lane either converges into the node or passes
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null) continue;
      if (lanes[i] === c.hash) {
        segs.push({ from: i, to: lane, kind: 'in', color: laneColor[i] ?? 0 });
      } else {
        segs.push({ from: i, to: i, kind: 'pass', color: laneColor[i] ?? 0 });
      }
    }
    for (const i of matching) lanes[i] = null;

    // bottom half: first parent continues this lane, extras fork out —
    // joining a lane that already expects them, else claiming a fresh one
    const [p0, ...rest] = c.parents;
    if (p0 !== undefined) {
      lanes[lane] = p0;
      segs.push({ from: lane, to: lane, kind: 'out', color });
    }
    for (const p of rest) {
      let j = -1;
      for (let i = 0; i < lanes.length; i++) {
        if (i !== lane && lanes[i] === p) {
          j = i;
          break;
        }
      }
      if (j < 0) j = claim(p, true);
      segs.push({ from: lane, to: j, kind: 'out', color: laneColor[j] ?? 0 });
    }

    let width = lane + 1;
    for (const s of segs) width = Math.max(width, s.from + 1, s.to + 1);
    rows.push({ lane, color, merge: c.parents.length > 1, segs, width });
  }
  return rows;
}
