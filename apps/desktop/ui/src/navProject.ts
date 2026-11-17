/**
 * Which project the collapsed-nav is showing.
 *
 * Pure so it can be tested: the rule looks trivial but the obvious
 * implementation has a nasty failure mode. The fallback for "focus doesn't
 * resolve right now" must be the project's ID, resolved against the CURRENT
 * tree — never a captured ProjectTree object. A captured object is a frozen
 * snapshot of that project's session list, so the chips kept offering sessions
 * that no longer existed (a handoff's retired predecessor, clickable, opening
 * a dead session), and its unchanging identity also pinned the downstream memo
 * so no later refresh could thaw it.
 */
export function resolveNavProject<T extends { projectId: string }>(args: {
  tree: readonly T[];
  /** project of the focused session, when that session is in the tree */
  focusedProjectId?: string;
  /** explicit override from the project dropdown */
  navProjectId?: string | null;
  /** last project we successfully resolved (an ID, by design) */
  lastProjectId?: string;
}): T | undefined {
  const { tree, focusedProjectId, navProjectId, lastProjectId } = args;
  const pid = navProjectId ?? focusedProjectId ?? lastProjectId;
  return tree.find((p) => p.projectId === pid) ?? tree[0];
}

/** The tree project that CONTAINS a session. Never use `session.projectId`
 *  for this: for workspace sessions the tree groups by repo (its projectId is
 *  the repo key) while the session node carries its own uuid — they differ,
 *  the lookup misses, and the collapsed-nav snaps to tree[0] on every focus
 *  change (the "project switcher jumps back" bug). */
export function projectIdOfSession<
  T extends { projectId: string; sessions: readonly { sessionId: string }[] },
>(tree: readonly T[], sessionId: string): string | undefined {
  return tree.find((p) => p.sessions.some((s) => s.sessionId === sessionId))?.projectId;
}

/** The session to jump to when the user picks a project in the collapsed-nav
 *  switcher: its most recently active one.
 *
 *  Ranking: a session superseded by a handoff successor is never a target;
 *  an `exited` tombstone loses to any live/hibernated session (you want the
 *  conversation you were having, not the dead one); within a tier, the newest
 *  `lastActiveAt` wins, falling back to `createdAt` so a freshly spawned
 *  session with no recorded activity yet still beats an older idle one. */
export function lastActiveSessionId(
  sessions: readonly {
    sessionId: string;
    state?: string;
    lastActiveAt?: string;
    createdAt?: string;
    replacedBySessionId?: string;
  }[],
): string | undefined {
  const live = sessions.filter((s) => !s.replacedBySessionId);
  if (live.length === 0) return undefined;
  const rank = (s: (typeof live)[number]): [number, string] => [
    s.state === 'exited' ? 0 : 1,
    s.lastActiveAt ?? s.createdAt ?? '',
  ];
  return live.reduce((best, s) => {
    const [bt, ba] = rank(best);
    const [st, sa] = rank(s);
    if (st !== bt) return st > bt ? s : best;
    return sa > ba ? s : best;
  }).sessionId;
}

/** Newest activity inside one project: the max `lastActiveAt` over its live
 *  sessions (`createdAt` as the fallback for one that hasn't spoken yet).
 *  `''` when the project has nothing live — those sort last. ISO-8601 strings
 *  compare chronologically, so no Date parsing is needed. */
export function projectRecency(
  sessions: readonly {
    lastActiveAt?: string;
    createdAt?: string;
    replacedBySessionId?: string;
  }[],
): string {
  let best = '';
  for (const s of sessions) {
    if (s.replacedBySessionId) continue; // retired handoff predecessor
    const at = s.lastActiveAt ?? s.createdAt ?? '';
    if (at > best) best = at;
  }
  return best;
}

/** The project list ordered most-recently-active first, for the collapsed-nav
 *  switcher: with a couple of dozen projects, the one you were just in should
 *  be at the top of the list, not wherever spawn order happened to put it.
 *
 *  Returns a NEW array — the tree's own order still drives the sidebar, and
 *  mutating it in place would reorder that too. Ties keep their original
 *  relative order, so projects with no activity at all don't shuffle around
 *  between renders. */
export function projectsByRecency<
  T extends {
    sessions: readonly {
      lastActiveAt?: string;
      createdAt?: string;
      replacedBySessionId?: string;
    }[];
  },
>(tree: readonly T[]): T[] {
  return tree
    .map((p, i) => ({ p, i, at: projectRecency(p.sessions) }))
    .sort((a, b) => (a.at === b.at ? a.i - b.i : a.at < b.at ? 1 : -1))
    .map((x) => x.p);
}
