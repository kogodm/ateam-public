import { describe, expect, it } from 'vitest';
import {
  atAtTokenAt,
  candidatesFromSessions,
  insertHumanMention,
  matchHumanMentions,
} from './humanMention';

describe('atAtTokenAt', () => {
  it('finds the @@ being typed at the caret', () => {
    expect(atAtTokenAt('ask @@Ali', 9)).toEqual({ start: 4, query: 'Ali' });
    expect(atAtTokenAt('@@', 2)).toEqual({ start: 0, query: '' });
    expect(atAtTokenAt('你好 @@读', 6)).toEqual({ start: 3, query: '读' });
  });
  it('does not treat a single @ as a human mention', () => {
    expect(atAtTokenAt('@src/app', 8)).toBeNull();
    expect(atAtTokenAt('mail a@b.com', 12)).toBeNull();
  });
  it('only what is before the caret counts', () => {
    expect(atAtTokenAt('@@Alice tail', 4)).toEqual({ start: 0, query: 'Al' });
  });
});

describe('insertHumanMention', () => {
  it('inserts display name plus ateam session id with a trailing space', () => {
    const tok = { start: 4 };
    expect(
      insertHumanMention('ask @@Al and', 9, tok, {
        name: 'Alice',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }),
    ).toEqual({
      text: 'ask @@Alice ateam:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee and',
      caret: 55,
    });
  });
});

describe('candidatesFromSessions / matchHumanMentions', () => {
  const rows = [
    {
      sessionId: 'self-id',
      humanName: 'Me',
      sessionName: 'me-session',
      projectId: 'proj-a',
      workspaceId: 'ws-/a',
      state: 'idle' as const,
    },
    {
      sessionId: 'peer-a',
      humanName: 'Alice',
      sessionName: 'alice-work',
      projectId: 'proj-a',
      workspaceId: 'ws-/a',
      state: 'idle' as const,
    },
    {
      sessionId: 'peer-other-proj',
      humanName: 'Bob',
      projectId: 'proj-b',
      workspaceId: 'ws-/b',
      state: 'idle' as const,
    },
    {
      sessionId: 'chat-1',
      humanName: 'Carol',
      sessionName: 'desk chat',
      projectId: 'desk-uuid',
      workspaceId: 'direct',
      state: 'working' as const,
    },
    {
      sessionId: 'gone',
      humanName: 'Gone',
      projectId: 'proj-a',
      workspaceId: 'ws-/a',
      state: 'exited' as const,
    },
    {
      sessionId: 'handed',
      humanName: 'Old',
      projectId: 'proj-a',
      workspaceId: 'ws-/a',
      state: 'idle' as const,
      replacedBySessionId: 'peer-a',
    },
  ];

  it('from a project session: same-project peers + Chats, not other projects', () => {
    const pool = candidatesFromSessions(rows, { sessionId: 'self-id', projectId: 'proj-a' });
    expect(pool.map((p) => p.sessionId).sort()).toEqual(['chat-1', 'peer-a']);
    expect(pool.find((p) => p.sessionId === 'peer-a')?.kind).toBe('project');
    expect(pool.find((p) => p.sessionId === 'chat-1')?.kind).toBe('chat');
  });

  it('from a Chat: only other Chats (no project peers without a project)', () => {
    const pool = candidatesFromSessions(rows, { sessionId: 'chat-1' });
    expect(pool.map((p) => p.sessionId)).toEqual([]);
    const withOtherChat = candidatesFromSessions(
      [
        ...rows,
        {
          sessionId: 'chat-2',
          humanName: 'Dan',
          projectId: 'desk-2',
          workspaceId: 'direct',
          state: 'idle',
        },
      ],
      { sessionId: 'chat-1' },
    );
    expect(withOtherChat.map((p) => p.sessionId)).toEqual(['chat-2']);
  });

  it('filters by human name and shows name + detail', () => {
    const pool = candidatesFromSessions(rows, { sessionId: 'self-id', projectId: 'proj-a' });
    const hits = matchHumanMentions(pool, 'ali');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.name).toBe('Alice');
    expect(hits[0]?.detail).toContain('Project');
    expect(hits[0]?.detail).toContain('peer-a');
  });
});
