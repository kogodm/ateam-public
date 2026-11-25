/**
 * `@@…` human/session mentions in the Stream compose box.
 *
 * `@path` is a file (see atMention.ts). `@@Name` opens teammates in the same
 * project, or directory-less Chats. The menu shows the human display name;
 * what is inserted (and sent to the model) also carries the Ateam session id
 * so `ateam-peers send_message` can address them unambiguously.
 */

export type HumanMentionCandidate = {
  sessionId: string;
  /** human display name — what the menu leads with */
  name: string;
  sessionName?: string;
  /** same-project peer vs directory-less Chat */
  kind: 'project' | 'chat';
  state?: string;
};

export type HumanMentionHit = HumanMentionCandidate & {
  /** secondary line in the menu */
  detail: string;
};

/** The `@@…` being typed at the caret. `start` is the index of the first `@`. */
export function atAtTokenAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const m = /(?:^|\s)@@(\S*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  const query = m[1] ?? '';
  return { start: caret - query.length - 2, query };
}

/**
 * Peers the current session may @@mention: other live sessions in the same
 * project, plus every directory-less Chat. Self and handed-off predecessors
 * are excluded; chat-mode backing rows (`chatId`) stay hidden.
 */
export function humanMentionPool(
  sessions: readonly HumanMentionCandidate[],
  self: { sessionId: string; projectId?: string },
): HumanMentionCandidate[] {
  return sessions.filter((s) => {
    if (s.sessionId === self.sessionId) return false;
    if (s.state === 'exited') return false;
    if (s.kind === 'chat') return true;
    return !!self.projectId && s.kind === 'project';
  });
}

/** Build candidates from session rows the App already has. */
export function candidatesFromSessions(
  sessions: readonly {
    sessionId: string;
    humanName: string;
    sessionName?: string;
    projectId: string;
    workspaceId: string;
    state: string;
    replacedBySessionId?: string;
    chatId?: string;
  }[],
  self: { sessionId: string; projectId?: string },
): HumanMentionCandidate[] {
  const out: HumanMentionCandidate[] = [];
  for (const s of sessions) {
    if (s.replacedBySessionId || s.chatId) continue;
    let kind: 'project' | 'chat' | null = null;
    if (s.workspaceId === 'direct') kind = 'chat';
    else if (self.projectId && s.projectId === self.projectId) kind = 'project';
    if (!kind) continue;
    out.push({
      sessionId: s.sessionId,
      name: s.humanName || s.sessionName || 'session',
      sessionName: s.sessionName,
      kind,
      state: s.state,
    });
  }
  return humanMentionPool(out, self);
}

/** Filter + decorate for the menu. Empty query → all, capped. */
export function matchHumanMentions(
  pool: readonly HumanMentionCandidate[],
  query: string,
  limit = 12,
): HumanMentionHit[] {
  const q = query.trim().toLowerCase();
  const hits: HumanMentionHit[] = [];
  for (const s of pool) {
    const detailParts = [
      s.kind === 'chat' ? 'Chat' : 'Project',
      s.sessionName && s.sessionName !== s.name ? s.sessionName : '',
      s.sessionId.slice(0, 8),
    ].filter(Boolean);
    const detail = detailParts.join(' · ');
    if (
      !q ||
      s.name.toLowerCase().includes(q) ||
      (s.sessionName ?? '').toLowerCase().includes(q) ||
      s.sessionId.toLowerCase().startsWith(q) ||
      detail.toLowerCase().includes(q)
    ) {
      hits.push({ ...s, detail });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/** Replace the `@@…` token with a name + ateam session id (trailing space). */
export function insertHumanMention(
  text: string,
  caret: number,
  token: { start: number },
  hit: { name: string; sessionId: string },
): { text: string; caret: number } {
  const safeName = hit.name.replace(/\s+/g, ' ').trim() || 'session';
  const ins = `@@${safeName} ateam:${hit.sessionId} `;
  const next = text.slice(0, token.start) + ins + text.slice(caret);
  return { text: next, caret: token.start + ins.length };
}
