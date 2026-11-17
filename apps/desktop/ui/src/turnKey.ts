/**
 * The identity a stream turn is de-duplicated by (live appends vs. what a
 * load already brought) and folds are keyed by.
 *
 * Time + role + text is not enough on its own: a message claude takes up
 * mid-turn is written twice with the SAME timestamp and text — the `enqueue`
 * that parks it and the `queued_command` attachment that carries it into the
 * conversation. Keyed alike, the live path dropped the second as a repeat:
 * the message left the queue tray and never reached the conversation until a
 * reload brought it back. Queue and injection markers are part of the key.
 */
export interface KeyedTurn {
  at: string;
  role: string;
  text: string;
  queued?: boolean;
  dequeued?: boolean;
  injected?: 'handoff' | 'mid_turn' | 'compaction';
}

export const keyOf = (t: KeyedTurn): string =>
  `${t.at}|${t.role}|${t.queued ? 'q|' : t.dequeued ? 'd|' : ''}${t.injected ?? ''}|${t.text.slice(0, 120)}`;
