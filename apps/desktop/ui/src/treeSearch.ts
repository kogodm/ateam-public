/**
 * The session tree's search box. Kept pure so the matching rules are tested:
 * a search that hides the session you typed the name of reads as "the session
 * is gone".
 */

export interface SearchGroup<S> {
  key: string;
  name: string;
  alias?: string;
  sessions: S[];
}

/** Lowercased, trimmed; '' means "not searching". */
export const normalizeQuery = (q: string): string => q.trim().toLowerCase();

const has = (text: string | undefined, q: string): boolean =>
  !!text && text.toLowerCase().includes(q);

/**
 * Narrow the tree to what matches `query`:
 *  - a group whose project name (or its display alias) matches keeps every
 *    session — searching for a project should show that project;
 *  - otherwise a group keeps only the sessions whose own name matches, or
 *    whose project does (in the Humans view a group is a person, and the
 *    project lives on each session);
 *  - groups left empty drop out.
 */
export function filterTree<S, G extends SearchGroup<S>>(
  groups: readonly G[],
  query: string,
  sessionName: (s: S) => string | undefined,
  sessionProject: (s: S) => readonly (string | undefined)[],
  /** false in the Humans view, where a group's name is a person, not a project */
  groupIsProject: boolean,
): G[] {
  const q = normalizeQuery(query);
  if (!q) return [...groups];
  const out: G[] = [];
  for (const g of groups) {
    if (groupIsProject && (has(g.name, q) || has(g.alias, q))) {
      out.push(g);
      continue;
    }
    const sessions = (g.sessions as S[]).filter(
      (s) => has(sessionName(s), q) || sessionProject(s).some((p) => has(p, q)),
    );
    if (sessions.length > 0) out.push({ ...g, sessions } as G);
  }
  return out;
}
