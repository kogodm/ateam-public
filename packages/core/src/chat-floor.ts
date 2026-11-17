import type { Chat } from './chat';
import type { ResponderReply } from './chat-responder';

/**
 * The floor: who may speak next in a chat.
 *
 * When the user posts, teammates do NOT all answer at once. The floor goes to
 * the lead (first in the roster) first; while they hold it the UI shows their
 * typing dots. When they release it — by answering, by passing, or by timing
 * out — it passes to the next teammate in roster order, who sees what was
 * already said and decides whether to add anything. So a group reply reads
 * like a conversation, not a pile-up, and the lead's split lands before the
 * others commit to anything. A DM is the same machine with one member.
 *
 * The talking itself is the one-shot in chat-responder.ts (injected as a
 * dependency so this stays a pure scheduler); its "work" hand-off goes to the
 * teammate's work session through `work()`.
 *
 * A newer user message while a round is running restarts the round from the
 * lead: the member currently speaking finishes (their answer is still to a
 * real message), the members after them are skipped, and the new round gives
 * everyone the full conversation including both messages.
 *
 * A teammate's work session delivering a result also opens a round — for the
 * OTHER members only — so a part that had to wait for that result can start
 * now instead of a work session idling on "wait for X". Those rounds are
 * expected to be mostly silent (the responder is told to speak only when the
 * result unblocks it or the user must know something).
 */

/** why a round is being run: the user posted, or a teammate's work session
 *  delivered a result the others may need to react to */
export type FloorTrigger = 'user' | 'peer-result';

export interface FloorDeps {
  /** run the teammate's chat-side reply; null = pass */
  respond(
    chat: Chat,
    humanId: string,
    ctx: { isLead: boolean; spokeBefore: string[]; trigger: FloorTrigger },
  ): Promise<ResponderReply | null>;
  /** post the reply into the chat as the teammate */
  say(chat: Chat, humanId: string, text: string): void;
  /** hand a task to the teammate's work session */
  work(chat: Chat, humanId: string, task: string): void;
  /** the floor changed hands (typing indicator) */
  changed(chatId: string): void;
}

export class ChatFloor {
  /** chatId → the teammate currently holding the floor */
  private readonly holder = new Map<string, string>();
  /** chatId → the round generation; a newer generation cancels the rest of
   *  an older round */
  private readonly gen = new Map<string, number>();
  /** chatId → the running round chain, so rounds never overlap */
  private readonly chain = new Map<string, Promise<void>>();

  constructor(private readonly deps: FloorDeps) {}

  /** who is "typing" in this chat right now */
  typingIn(chatId: string): string | null {
    return this.holder.get(chatId) ?? null;
  }

  /** the user posted in `chat` — start (or restart) a reply round */
  userSaid(chat: Chat): void {
    this.startRound(chat, chat.members, 'user');
  }

  /** `from`'s work session delivered a result — let the others react */
  peerResult(chat: Chat, from: string): void {
    this.startRound(
      chat,
      chat.members.filter((m) => m !== from),
      'peer-result',
    );
  }

  private startRound(chat: Chat, members: string[], trigger: FloorTrigger): void {
    if (members.length === 0) return;
    const gen = (this.gen.get(chat.id) ?? 0) + 1;
    this.gen.set(chat.id, gen);
    const prev = this.chain.get(chat.id) ?? Promise.resolve();
    const next = prev.then(() => this.runRound(chat, members, gen, trigger)).catch(() => undefined);
    this.chain.set(chat.id, next);
  }

  private async runRound(
    chat: Chat,
    members: string[],
    gen: number,
    trigger: FloorTrigger,
  ): Promise<void> {
    const spoke: string[] = [];
    for (let i = 0; i < members.length; i++) {
      const humanId = members[i];
      if (!humanId) continue;
      // a newer message restarts from the lead; the rest of this round is moot
      if (this.gen.get(chat.id) !== gen) return;
      // typing dots promise the user a reply is coming; a peer-result round
      // is expected to be silent, so it composes without them
      if (trigger === 'user') {
        this.holder.set(chat.id, humanId);
        this.deps.changed(chat.id);
      }
      let reply: ResponderReply | null = null;
      try {
        reply = await this.deps.respond(chat, humanId, {
          isLead: humanId === chat.members[0],
          spokeBefore: spoke,
          trigger,
        });
      } catch {
        reply = null;
      }
      if (this.holder.get(chat.id) === humanId) this.holder.delete(chat.id);
      if (reply?.say) {
        try {
          this.deps.say(chat, humanId, reply.say);
        } catch {
          /* the log is best-effort; the round goes on */
        }
      }
      if (reply?.work) {
        try {
          this.deps.work(chat, humanId, reply.work);
        } catch {
          /* a work session that failed to start must not block the others */
        }
      }
      spoke.push(humanId);
      this.deps.changed(chat.id);
    }
  }
}
