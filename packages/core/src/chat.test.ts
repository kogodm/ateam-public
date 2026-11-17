import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// isolate the store under a throwaway ATEAM_HOME per test
let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.ATEAM_HOME;
  home = mkdtempSync(join(tmpdir(), 'ateam-chat-'));
  process.env.ATEAM_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) process.env.ATEAM_HOME = '';
  else process.env.ATEAM_HOME = prevHome;
});

async function fresh() {
  // re-import so ateamHome() reads the current env (paths caches nothing, but
  // keep it simple and explicit)
  return await import('./chat');
}

describe('chat store', () => {
  it('creates a chat and lists it, newest first', async () => {
    const c = await fresh();
    const a = c.createChat({ kind: 'dm', name: 'Zalu', members: ['h1'], workdir: '/w' });
    const b = c.createChat({
      kind: 'group',
      name: 'Backend',
      members: ['h1', 'h2'],
      workdir: '/w',
    });
    const list = c.listChats();
    expect(list.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(c.getChat(a.id)?.name).toBe('Zalu');
    expect(list[0]?.members).toEqual(['h1', 'h2']);
  });

  it('dedupes members and drops blanks', async () => {
    const c = await fresh();
    const g = c.createChat({
      kind: 'group',
      name: 'G',
      members: ['h1', 'h1', '', 'h2'],
      workdir: '/w',
    });
    expect(g.members).toEqual(['h1', 'h2']);
  });

  it('appends messages and reads them in order', async () => {
    const c = await fresh();
    const g = c.createChat({ kind: 'dm', name: 'Z', members: ['h1'], workdir: '/w' });
    c.appendMessage({ chatId: g.id, from: 'user', text: 'do the thing' });
    c.appendMessage({ chatId: g.id, from: 'h1', kind: 'status', text: 'on it' });
    c.appendMessage({
      chatId: g.id,
      from: 'h1',
      kind: 'result',
      text: 'done',
      attachments: [{ name: 'report.md', path: '/w/report.md' }],
    });
    const msgs = c.readMessages(g.id);
    expect(msgs.map((m) => m.text)).toEqual(['do the thing', 'on it', 'done']);
    expect(msgs[0]?.from).toBe('user');
    expect(msgs[2]?.attachments?.[0]?.path).toBe('/w/report.md');
  });

  it('readMessages(sinceTs) returns only newer messages', async () => {
    const c = await fresh();
    const g = c.createChat({ kind: 'dm', name: 'Z', members: ['h1'], workdir: '/w' });
    const first = c.appendMessage({ chatId: g.id, from: 'user', text: 'one' });
    await new Promise((r) => setTimeout(r, 2));
    c.appendMessage({ chatId: g.id, from: 'h1', text: 'two' });
    const after = c.readMessages(g.id, first.ts);
    expect(after.map((m) => m.text)).toEqual(['two']);
  });

  it('finds chats a teammate belongs to', async () => {
    const c = await fresh();
    c.createChat({ kind: 'dm', name: 'Z', members: ['h1'], workdir: '/w' });
    c.createChat({ kind: 'group', name: 'G', members: ['h2', 'h3'], workdir: '/w' });
    expect(c.chatsForHuman('h1').length).toBe(1);
    expect(c.chatsForHuman('h9').length).toBe(0);
  });

  it('updates and deletes a chat (log survives delete)', async () => {
    const c = await fresh();
    const g = c.createChat({ kind: 'group', name: 'G', members: ['h1'], workdir: '/w' });
    c.appendMessage({ chatId: g.id, from: 'user', text: 'hi' });
    c.updateChat(g.id, { name: 'Renamed', members: ['h1', 'h2'], purpose: 'backend only' });
    expect(c.getChat(g.id)?.name).toBe('Renamed');
    expect(c.getChat(g.id)?.purpose).toBe('backend only');
    c.deleteChat(g.id);
    expect(c.getChat(g.id)).toBeUndefined();
    // records kept
    expect(c.readMessages(g.id).map((m) => m.text)).toEqual(['hi']);
  });
});
