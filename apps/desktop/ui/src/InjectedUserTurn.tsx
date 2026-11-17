import type { ReactNode } from 'react';

export type InjectedUserKind = 'handoff' | 'mid_turn' | 'compaction';

export function confirmsOptimisticUserTurn(turn: {
  role: string;
  injected?: InjectedUserKind;
}): boolean {
  return turn.role === 'user' && turn.injected !== 'handoff' && turn.injected !== 'compaction';
}

export function InjectedUserTurnCard({
  kind,
  children,
  timeTitle,
}: {
  kind: InjectedUserKind;
  children: ReactNode;
  timeTitle?: string;
}): JSX.Element {
  const title =
    kind === 'handoff'
      ? 'Session handoff'
      : kind === 'compaction'
        ? 'Context compacted by Claude'
        : 'Mid-turn message';
  return (
    <details
      className={`sv-turn sv-injected sv-injected-${kind}`}
      open={kind === 'mid_turn'}
      title={timeTitle}
    >
      <summary className="sv-injected-summary">{title}</summary>
      <div className="sv-injected-body">{children}</div>
    </details>
  );
}
