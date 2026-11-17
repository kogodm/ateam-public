import type { ProjectTree, SessionNode, SessionStateAgent } from '@ateam/contract';

function toAgent(p: ProjectTree, s: SessionNode): SessionStateAgent {
  return {
    projectName: p.name,
    agentName: s.agentName,
    role: s.role,
    dir: s.cwd,
    claudeSessionId: s.claudeSessionId,
    directoryless: s.workspaceId === 'direct',
    providerId: s.providerId,
  };
}

/**
 * The session set written to tui-state.json: what the tree has, then what
 * was saved at boot and is not in the tree this time (restore picked only
 * some), deduped by claudeSessionId.
 *
 * EXITED sessions are kept. An exited row is a tombstone with a Recover
 * button, not a removal — removal is `deleteSession`, which also drops the id
 * from `remembered`. Skipping exited rows here meant a session whose resume
 * failed at launch (codex refusing a rollout filename, 2026-10-15) was
 * forgotten on the next save and vanished from the tree for good, though its
 * history was intact. Live rows come first so a recovered session's fresh
 * metadata wins over its tombstone.
 *
 * Handed-off sessions (replacedBySessionId) are never written: the successor
 * stands for the conversation, and both rows would come back next launch.
 */
export function agentsToPersist(
  tree: ProjectTree[],
  remembered: SessionStateAgent[],
): SessionStateAgent[] {
  const out: SessionStateAgent[] = [];
  const seen = new Set<string>();
  const add = (p: ProjectTree, s: SessionNode): void => {
    if (s.replacedBySessionId || seen.has(s.claudeSessionId)) return;
    seen.add(s.claudeSessionId);
    out.push(toAgent(p, s));
  };
  for (const p of tree) for (const s of p.sessions) if (s.state !== 'exited') add(p, s);
  for (const p of tree) for (const s of p.sessions) if (s.state === 'exited') add(p, s);
  // everything the tree knows, handed-off ones included, so a retired session
  // is not mistaken for "not restored this time" and brought back
  const known = new Set(tree.flatMap((p) => p.sessions).map((s) => s.claudeSessionId));
  for (const a of remembered) {
    if (known.has(a.claudeSessionId) || seen.has(a.claudeSessionId)) continue;
    seen.add(a.claudeSessionId);
    out.push(a);
  }
  return out;
}
