/** Aggregate a group's sessions into the ONE dot a collapsed header / the
 *  project switcher shows. Priority mirrors a session row's own dot:
 *  blocked menu > context limit > unread output > busy > nothing.
 *  The focused session is excluded — the user is looking at it. */
export type ProjectDot = 'menu' | 'limit' | 'attn' | 'busy' | undefined;

export interface StatusInputs {
  focused: string;
  pendingMenu: ReadonlySet<string>;
  unread: ReadonlySet<string>;
  tokenEst: ReadonlyMap<string, number>;
  threshold: number;
  /** last PTY output per session (ms epoch) */
  lastOutput: ReadonlyMap<string, number>;
  now: number;
}

export function projectStatus(
  sessions: readonly { sessionId: string; state: string; replacedBySessionId?: string }[],
  i: StatusInputs,
): ProjectDot {
  const others = sessions.filter((s) => s.sessionId !== i.focused && !s.replacedBySessionId);
  if (others.some((s) => i.pendingMenu.has(s.sessionId))) return 'menu';
  if (others.some((s) => (i.tokenEst.get(s.sessionId) ?? 0) >= i.threshold)) return 'limit';
  if (others.some((s) => i.unread.has(s.sessionId))) return 'attn';
  if (others.some((s) => s.state !== 'exited' && i.now - (i.lastOutput.get(s.sessionId) ?? 0) < 500))
    return 'busy';
  return undefined;
}
