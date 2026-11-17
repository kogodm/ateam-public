import { describe, expect, it } from 'vitest';
import type { Chat } from './chat';
import { ChatFloor, type FloorDeps } from './chat-floor';
import type { ResponderReply } from './chat-responder';

const chat = (members: string[]): Chat => ({
  id: 'c1',
  kind: members.length > 1 ? 'group' : 'dm',
  name: 'team',
  members,
  workdir: '/w',
  createdAt: 0,
});

/** a deferred responder per teammate so a test can control who answers when */
function harness(replies: Record<string, ResponderReply | null>) {
  const log: string[] = [];
  const pending = new Map<string, (r: ResponderReply | null) => void>();
  const deps: FloorDeps = {
    respond(_c, humanId, ctx) {
      log.push(
        `ask:${humanId}${ctx.isLead ? ':lead' : ''}:[${ctx.spokeBefore.join(',')}]${ctx.trigger === 'peer-result' ? ':peer' : ''}`,
      );
      return new Promise((res) => pending.set(humanId, res));
    },
    say: (_c, humanId, text) => log.push(`say:${humanId}:${text}`),
    work: (_c, humanId, task) => log.push(`work:${humanId}:${task}`),
    changed: () => log.push('changed'),
  };
  const floor = new ChatFloor(deps);
  const answer = async (humanId: string): Promise<void> => {
    pending.get(humanId)?.(replies[humanId] ?? null);
    pending.delete(humanId);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return { floor, log, answer, pending };
}

describe('ChatFloor', () => {
  it('hands the floor to the lead first, then the rest in roster order', async () => {
    const h = harness({
      a: { say: 'a takes X, b takes Y', work: 'do X' },
      b: { say: '', work: 'do Y' },
    });
    h.floor.userSaid(chat(['a', 'b']));
    await new Promise((r) => setImmediate(r));
    expect(h.floor.typingIn('c1')).toBe('a');
    expect(h.pending.has('b')).toBe(false); // b is not even asked yet
    await h.answer('a');
    expect(h.log).toContain('say:a:a takes X, b takes Y');
    expect(h.log).toContain('work:a:do X');
    expect(h.floor.typingIn('c1')).toBe('b');
    await h.answer('b');
    expect(h.floor.typingIn('c1')).toBeNull();
    expect(h.log.filter((l) => l.startsWith('say:'))).toEqual(['say:a:a takes X, b takes Y']);
    expect(h.log).toContain('work:b:do Y');
    expect(h.log).toContain('ask:b:[a]');
  });

  it('a pass (null) posts nothing and moves on', async () => {
    const h = harness({ a: null, b: { say: 'hi', work: '' } });
    h.floor.userSaid(chat(['a', 'b']));
    await new Promise((r) => setImmediate(r));
    await h.answer('a');
    expect(h.log.some((l) => l.startsWith('say:a') || l.startsWith('work:a'))).toBe(false);
    expect(h.floor.typingIn('c1')).toBe('b');
    await h.answer('b');
    expect(h.log).toContain('say:b:hi');
  });

  it('a newer user message restarts from the lead and skips the rest of the old round', async () => {
    const h = harness({ a: { say: 'a1', work: '' }, b: { say: 'b1', work: '' } });
    const c = chat(['a', 'b']);
    h.floor.userSaid(c);
    await new Promise((r) => setImmediate(r));
    expect(h.floor.typingIn('c1')).toBe('a');
    h.floor.userSaid(c); // user posts again while a is composing
    await h.answer('a'); // a's answer to the first message still lands
    expect(h.log).toContain('say:a:a1');
    // b's turn of the old round is skipped; the new round starts with a again
    expect(h.floor.typingIn('c1')).toBe('a');
    expect(h.log.filter((l) => l.startsWith('ask:a')).length).toBe(2);
    expect(h.log.filter((l) => l.startsWith('ask:b')).length).toBe(0);
    await h.answer('a');
    expect(h.floor.typingIn('c1')).toBe('b');
    await h.answer('b');
    expect(h.floor.typingIn('c1')).toBeNull();
  });

  it('a DM is the same machine with one member', async () => {
    const h = harness({ a: { say: 'ok', work: 'do it' } });
    h.floor.userSaid(chat(['a']));
    await new Promise((r) => setImmediate(r));
    expect(h.floor.typingIn('c1')).toBe('a');
    await h.answer('a');
    expect(h.log).toContain('say:a:ok');
    expect(h.log).toContain('work:a:do it');
    expect(h.floor.typingIn('c1')).toBeNull();
  });

  it("a teammate's result opens a round for the others only", async () => {
    const h = harness({ a: { say: '', work: 'review b' }, b: { say: 'x', work: '' } });
    h.floor.peerResult(chat(['a', 'b']), 'b');
    await new Promise((r) => setImmediate(r));
    expect(h.floor.typingIn('c1')).toBeNull(); // silent round: no typing dots
    expect(h.log).toContain('ask:a:lead:[]:peer');
    await h.answer('a');
    expect(h.log).toContain('work:a:review b');
    expect(h.floor.typingIn('c1')).toBeNull();
    expect(h.log.some((l) => l.startsWith('ask:b'))).toBe(false);
  });

  it('a responder that throws counts as a pass', async () => {
    const deps: FloorDeps = {
      respond: () => Promise.reject(new Error('boom')),
      say: () => undefined,
      work: () => undefined,
      changed: () => undefined,
    };
    const floor = new ChatFloor(deps);
    floor.userSaid(chat(['a', 'b']));
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    expect(floor.typingIn('c1')).toBeNull();
  });
});
