import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InjectedUserTurnCard, confirmsOptimisticUserTurn } from './InjectedUserTurn';

describe('InjectedUserTurnCard', () => {
  it('keeps handoff content collapsed under a neutral label', () => {
    const html = renderToStaticMarkup(
      <InjectedUserTurnCard kind="handoff">{'First line\nSecond line'}</InjectedUserTurnCard>,
    );
    expect(html).toContain('Session handoff');
    expect(html).toContain('First line\nSecond line');
    expect(html).not.toMatch(/<details[^>]*\bopen=/);
  });

  it('shows a mid-turn message body by default', () => {
    const html = renderToStaticMarkup(
      <InjectedUserTurnCard kind="mid_turn">Queued message body</InjectedUserTurnCard>,
    );
    expect(html).toContain('<details class="sv-turn sv-injected sv-injected-mid_turn" open="">');
    expect(html).toContain('Mid-turn message');
    expect(html).toContain('Queued message body');
  });

  it("keeps Claude's compaction summary collapsed under its own label", () => {
    const html = renderToStaticMarkup(
      <InjectedUserTurnCard kind="compaction">
        {'This session is being continued'}
      </InjectedUserTurnCard>,
    );
    expect(html).toContain('Context compacted by Claude');
    expect(html).toContain('This session is being continued');
    expect(html).not.toMatch(/<details[^>]*\bopen=/);
  });

  it('does not let a compaction summary acknowledge a human send either', () => {
    expect(confirmsOptimisticUserTurn({ role: 'user', injected: 'compaction' })).toBe(false);
  });

  it('does not let a handoff acknowledge a human send, but keeps mid-turn messages eligible', () => {
    expect(confirmsOptimisticUserTurn({ role: 'user', injected: 'handoff' })).toBe(false);
    expect(confirmsOptimisticUserTurn({ role: 'user', injected: 'mid_turn' })).toBe(true);
    expect(confirmsOptimisticUserTurn({ role: 'user' })).toBe(true);
  });
});
