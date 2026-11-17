import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalConversations } from './external-conversations';
import { externalReadiness } from './external-readiness';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'ateam-external-test-'));
  homes.push(home);
  const peer = {
    id: 'session-1',
    name: 'Coder',
    provider: 'codex',
    projectDir: home,
    state: 'idle' as const,
    model: '',
  };
  const peers = [peer, { ...peer, id: 'session-2' }];
  const deps = { list: () => peers, deliver: vi.fn(() => true) };
  const clients = [
    { id: 'alice', roots: [home] },
    { id: 'bob', roots: [home] },
  ];
  const store = new ExternalConversations(home, clients, deps);
  const listed = store.listSessions('alice')[0];
  if (!listed) throw new Error('Missing fixture session');
  const project = listed.project_id;
  const args = {
    project_id: project,
    session_id: peer.id,
    message: 'hello',
    idempotency_key: 'first',
  };
  return { home, peer, peers, deps, clients, store, project, args };
}

function setupRunLinks() {
  const home = mkdtempSync(join(tmpdir(), 'ateam-run-link-project-'));
  const otherProject = mkdtempSync(join(tmpdir(), 'ateam-run-link-other-'));
  homes.push(home, otherProject);
  const realHome = realpathSync(home);
  const realOtherProject = realpathSync(otherProject);
  const peers = [
    {
      id: 'runtime-a',
      stable_id: 'cli-session-a',
      name: 'A',
      provider: 'codex',
      projectDir: realHome,
      state: 'idle' as const,
      model: '',
    },
    {
      id: 'runtime-b',
      stable_id: 'cli-session-b',
      name: 'B',
      provider: 'claude',
      projectDir: realHome,
      state: 'idle' as const,
      model: '',
    },
    {
      id: 'runtime-other',
      stable_id: 'cli-session-other',
      name: 'Other',
      provider: 'codex',
      projectDir: realOtherProject,
      state: 'idle' as const,
      model: '',
    },
  ];
  const clients = [
    { id: 'alice', roots: [realHome, realOtherProject] },
    { id: 'bob', roots: [realHome, realOtherProject] },
  ];
  const store = new ExternalConversations(home, clients, { list: () => peers, deliver: () => true });
  const projects = store.listProjects('alice');
  const project = projects.find((p) => p.root === realHome)?.project_id;
  const otherProjectId = projects.find((p) => p.root === realOtherProject)?.project_id;
  if (!project || !otherProjectId) throw new Error('Missing fixture projects');
  return { store, peers, project, otherProjectId };
}

describe('external conversations', () => {
  it('resolves explicit stable session and conversation links to the live runtime session', () => {
    const { store, project } = setupRunLinks();
    expect(store.resolveRunLink('alice', project)).toBeUndefined();
    expect(store.resolveRunLink('alice', project, 'cli-session-a')).toEqual({
      sessionId: 'runtime-a',
      stableSessionId: 'cli-session-a',
    });

    const conversation = store.send('alice', {
      project_id: project,
      session_id: 'cli-session-a',
      message: 'work on this session',
      idempotency_key: 'run-link',
    });
    expect(store.resolveRunLink('alice', project, undefined, conversation.conversation_id)).toEqual({
      sessionId: 'runtime-a',
      stableSessionId: 'cli-session-a',
    });
  });

  it('rejects conflicting, unavailable, cross-client and cross-project run links', () => {
    const { store, project, otherProjectId } = setupRunLinks();
    const conversation = store.send('alice', {
      project_id: project,
      session_id: 'cli-session-a',
      message: 'work on this session',
      idempotency_key: 'run-link-conflict',
    });

    expect(() =>
      store.resolveRunLink('alice', project, 'cli-session-b', conversation.conversation_id),
    ).toThrow('conversation_session_mismatch');
    expect(() => store.resolveRunLink('bob', project, undefined, conversation.conversation_id)).toThrow(
      'conversation_not_found',
    );
    expect(() =>
      store.resolveRunLink('alice', otherProjectId, undefined, conversation.conversation_id),
    ).toThrow('conversation_not_found');
    expect(() => store.resolveRunLink('alice', project, 'cli-session-a-prefix')).toThrow(
      'session_unavailable',
    );
    expect(() => store.resolveRunLink('alice', 'not-authorized', 'cli-session-a')).toThrow(
      'project_not_authorized',
    );
  });

  it('isolates clients including keys, conversations, replies and cancellation', () => {
    const { store, args, project, peer } = setup();
    const a = store.send('alice', args);
    const b = store.send('bob', args);
    expect(a.conversation_id).not.toBe(b.conversation_id);
    expect(() => store.read('bob', project, a.conversation_id)).toThrow('conversation_not_found');
    expect(() => store.cancel('bob', project, a.conversation_id, a.message_id)).toThrow(
      'conversation_not_found',
    );
    expect(store.listConversations('bob', project).conversations).toHaveLength(1);
    store.pump();
    expect(() =>
      store.reply(
        { ...peer, id: 'session-2' },
        `external:${a.conversation_id}:${a.message_id}`,
        'spoof',
      ),
    ).toThrow('reply_not_authorized');
    store.reply(peer, `external:${a.conversation_id}:${a.message_id}`, 'answer');
    expect(store.read('alice', project, a.conversation_id).messages[1]?.in_reply_to).toBe(
      a.message_id,
    );
    expect(store.read('bob', project, b.conversation_id).messages).toHaveLength(1);
  });

  it('persists idempotency and history across reconnect/restart without redispatch', () => {
    const { store, args, home, clients, deps, project, peer } = setup();
    const sent = store.send('alice', args);
    store.pump();
    store.reply(peer, `external:${sent.conversation_id}:${sent.message_id}`, 'answer');
    const restarted = new ExternalConversations(home, clients, deps);
    expect(restarted.send('alice', args).message_id).toBe(sent.message_id);
    restarted.pump();
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(restarted.read('alice', project, sent.conversation_id, 1).messages[0]?.text).toBe(
      'answer',
    );
    expect(() => restarted.send('alice', { ...args, message: 'changed' })).toThrow(
      'idempotency_conflict',
    );
  });

  it('submits without waiting for replies, one paste per session per tick', () => {
    const { store, args, deps } = setup();
    store.send('alice', args);
    store.send('bob', args);
    store.send('bob', { ...args, session_id: 'session-2', idempotency_key: 'second' });
    store.pump();
    // alice on session-1 and bob on session-2; bob's session-1 message waits one tick
    expect(deps.deliver).toHaveBeenCalledTimes(2);
    store.pump();
    // no reply needed: the CLI queues it behind the first
    expect(deps.deliver).toHaveBeenCalledTimes(3);
    store.pump();
    expect(deps.deliver).toHaveBeenCalledTimes(3);
  });

  it('addresses a session by its CLI id, so an Ateam restart keeps the conversation', () => {
    const home = mkdtempSync(join(tmpdir(), 'ateam-external-stable-'));
    homes.push(home);
    const before = {
      id: 'ateam-row-1',
      stable_id: 'codex-thread-9',
      name: 'Coder',
      provider: 'codex',
      projectDir: home,
      state: 'working' as const,
      model: '',
    };
    let peers = [before];
    const deps = { list: () => peers, deliver: vi.fn(() => false) };
    const clients = [{ id: 'alice', roots: [home] }];
    const store = new ExternalConversations(home, clients, deps);
    const listed = store.listSessions('alice')[0];
    expect(listed?.id).toBe('codex-thread-9');
    expect(listed).not.toHaveProperty('stable_id');
    const sent = store.send('alice', {
      project_id: listed?.project_id as string,
      session_id: 'codex-thread-9',
      message: 'hello',
      idempotency_key: 'k',
    });
    store.pump(); // held (dialog on screen): stays queued
    // Ateam restarts: the row gets a new in-process id, the CLI thread is resumed
    const after = { ...before, id: 'ateam-row-2' };
    peers = [after];
    const restarted = new ExternalConversations(home, clients, {
      ...deps,
      deliver: vi.fn(() => true),
    });
    restarted.pump();
    expect(
      restarted.read('alice', listed?.project_id as string, sent.conversation_id).messages[0]
        ?.status,
    ).toBe('delivered');
    restarted.reply(after, `external:${sent.conversation_id}:${sent.message_id}`, 'done');
    expect(
      restarted.read('alice', listed?.project_id as string, sent.conversation_id).messages[1]
        ?.text,
    ).toBe('done');
  });

  it('keeps busy input queued and permits cancellation without sending', () => {
    const { store, args, deps, project } = setup();
    deps.deliver.mockReturnValue(false);
    const sent = store.send('alice', args);
    store.pump();
    expect(store.read('alice', project, sent.conversation_id).messages[0]?.status).toBe('queued');
    store.cancel('alice', project, sent.conversation_id, sent.message_id);
    deps.deliver.mockClear();
    store.pump();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it('does not replay an uncertain delivery after a crash', () => {
    const { store, args, home, clients, deps, project } = setup();
    const sent = store.send('alice', args);
    const path = join(home, 'external-mcp', 'conversations.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    saved[0].messages[0].status = 'delivering';
    writeFileSync(path, JSON.stringify(saved));
    const restarted = new ExternalConversations(home, clients, deps);
    restarted.pump();
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(restarted.read('alice', project, sent.conversation_id).messages[0]?.status).toBe(
      'delivery_unknown',
    );
  });

  it('rejects unauthorized projects, terminal escapes and disappeared sessions', () => {
    const { store, args, peers, project } = setup();
    expect(store.listSessions('unknown')).toEqual([]);
    expect(() => store.send('unknown', args)).toThrow('project_not_authorized');
    expect(() => store.send('alice', { ...args, message: '\x1b[201~bad\r' })).toThrow(
      'invalid_message',
    );
    const sent = store.send('alice', args);
    peers.length = 0;
    store.pump();
    expect(store.read('alice', project, sent.conversation_id).messages[0]?.status).toBe(
      'session_unavailable',
    );
  });

  it('redacts known credentials and bounds UTF-8 pages', () => {
    const { store, args, project, peer } = setup();
    const sent = store.send('alice', args);
    store.pump();
    const address = `external:${sent.conversation_id}:${sent.message_id}`;
    store.reply(peer, address, 'Authorization: Bearer abcsecret password=hidden');
    store.reply(peer, address, '一'.repeat(16_000));
    store.reply(peer, address, '二'.repeat(16_000));
    const page = store.read('alice', project, sent.conversation_id);
    expect(JSON.stringify(page)).not.toContain('abcsecret');
    expect(JSON.stringify(page)).not.toContain('hidden');
    expect(page.has_more).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(66_000);
    expect(
      store.read('alice', project, sent.conversation_id, page.next_cursor).messages,
    ).toHaveLength(1);
  });
});

describe('external input readiness', () => {
  const line = (r: unknown) => JSON.stringify(r);
  it('uses Codex turn events, not silence or prose', () => {
    const done = line({ type: 'event_msg', payload: { type: 'task_complete' } });
    expect(externalReadiness('codex', [done])).toBe('ready');
    expect(
      externalReadiness('codex', [
        done,
        line({ type: 'event_msg', payload: { type: 'task_started' } }),
      ]),
    ).toBe('busy');
    expect(externalReadiness('codex', [done, '{partial'])).toBe('unknown');
  });
  it('requires Claude completion evidence, preserving pending tool approval', () => {
    const done = line({ type: 'system', subtype: 'turn_duration' });
    expect(externalReadiness('claude', [done])).toBe('ready');
    expect(
      externalReadiness('claude', [
        done,
        line({ type: 'assistant', message: { stop_reason: 'tool_use' } }),
      ]),
    ).toBe('busy');
    expect(
      externalReadiness('claude', [
        line({ type: 'assistant', message: { stop_reason: 'end_turn' } }),
      ]),
    ).toBe('ready');
    expect(externalReadiness('claude', [])).toBe('unknown');
    expect(externalReadiness('opencode', [done])).toBe('unknown');
  });
});

describe('grants naming a project that was deleted', () => {
  it('skips the missing root instead of failing every other grant', () => {
    const { home, peers, deps } = setup();
    const store = new ExternalConversations(
      home,
      [{ id: 'alice', roots: [home, join(home, 'deleted-worktree')] }],
      deps,
    );
    expect(store.listProjects('alice')).toHaveLength(1);
    expect(store.listSessions('alice')).toHaveLength(peers.length);
  });
});
