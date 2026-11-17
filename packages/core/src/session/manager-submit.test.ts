import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as providerStore from './provider-store';

/** A fake PTY that records writes and lets the test play the TUI's output. */
const ptys: { writes: string[]; emit: (d: string) => void }[] = [];
vi.mock('node-pty', () => ({
  spawn: () => {
    let onData: (d: string) => void = () => {};
    const rec = { writes: [] as string[], emit: (d: string) => onData(d) };
    ptys.push(rec);
    return {
      onData: (cb: (d: string) => void) => {
        onData = cb;
        return { dispose: () => {} };
      },
      onExit: () => ({ dispose: () => {} }),
      write: (d: string) => rec.writes.push(d),
      resize: () => {},
      kill: () => {},
      pid: 4321,
    };
  },
}));

const { SessionManager } = await import('./manager');

/** The Enter after a message must reach claude as its OWN read — a busy
 *  machine that sat on stdin used to get text + Enter in one read, and the
 *  Enter became a newline in the input box. */
describe('submit-Enter waits for the TUI to read the text', () => {
  let home: string;
  let prevHome: string | undefined;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-submit-spec-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });
  afterAll(() => {
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  const setup = () => {
    const m = new SessionManager();
    const node = m.spawn({
      projectName: 'proj-s',
      agentName: `a${ptys.length}`,
      role: 'coder',
      workspace: { id: 'ws-s', name: 'proj-s', root: home },
    });
    const pty = ptys.at(-1);
    if (!pty) throw new Error('no pty');
    pty.writes.length = 0;
    return { m, id: node.sessionId, pty };
  };

  it('delivers peer messages through input as a paste then a paced Enter', async () => {
    vi.useFakeTimers();
    const { m, id, pty } = setup();
    const sender = m.spawn({
      agentName: 'sender',
      role: 'coder',
      workspace: { id: 'ws-s', name: 'proj-s', root: home },
    });
    const input = vi.spyOn(m, 'input');
    expect(
      m.handlePeerRequest({
        kind: 'send',
        from: sender.sessionId,
        to: id,
        message: 'first\nsecond',
      }),
    ).toEqual({ ok: true, message: expect.stringMatching(/^Message sent to /) });
    expect(input.mock.calls).toEqual([
      [
        id,
        expect.stringMatching(
          /^\x1b\[200~Another Claude session[\s\S]*first\nsecond[\s\S]*\x1b\[201~$/,
        ),
      ],
      [id, '\r'],
    ]);
    expect(pty.writes).toHaveLength(1);
    pty.emit('read paste');
    await vi.advanceTimersByTimeAsync(200);
    expect(pty.writes[1]).toBe('\r');
    m.shutdown();
    vi.useRealTimers();
  });

  /** Lets the headless screen finish parsing what the fake TUI printed. */
  const settle = () => new Promise<void>((r) => setTimeout(r, 30));

  it('submits external input at once, even while the CLI is busy', async () => {
    const { m, id, pty } = setup();
    const path = join(home, 'external-busy.jsonl');
    // mid-turn: a tool is running
    writeFileSync(path, `${JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use' } })}\n`);
    const source = vi.spyOn(providerStore, 'storeTranscriptPath').mockReturnValue(path);
    try {
      expect(m.deliverExternalMessage(id, 'external question')).toBe(true);
      expect(pty.writes).toEqual(['\x1b[200~external question\x1b[201~']);
      // a second message while the first Enter is held goes in after it, in order
      expect(m.deliverExternalMessage(id, 'second question')).toBe(true);
      pty.emit('read paste');
      await new Promise((r) => setTimeout(r, 400));
      pty.emit('read second paste');
      await new Promise((r) => setTimeout(r, 400));
      expect(pty.writes).toEqual([
        '\x1b[200~external question\x1b[201~',
        '\r',
        '\x1b[200~second question\x1b[201~',
        '\r',
      ]);
    } finally {
      source.mockRestore();
      m.shutdown();
    }
  });

  it('typed text and terminal reports never hold external delivery', async () => {
    const { m, id } = setup();
    const path = join(home, 'external-typed.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'system', subtype: 'turn_duration' })}\n`);
    const source = vi.spyOn(providerStore, 'storeTranscriptPath').mockReturnValue(path);
    try {
      m.input(id, '\x1b[<64;10;5M');
      m.input(id, '\x1b[I');
      m.input(id, '/model');
      expect(m.listPeerSessions().find((p) => p.id === id)?.input_status).toBe('ready');
      expect(m.deliverExternalMessage(id, 'still goes')).toBe(true);
    } finally {
      source.mockRestore();
      m.shutdown();
    }
  });

  it('holds external input while a dialog is on screen, so Enter cannot answer it', async () => {
    const { m, id, pty } = setup();
    const path = join(home, 'external-dialog.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use' } })}\n`);
    const source = vi.spyOn(providerStore, 'storeTranscriptPath').mockReturnValue(path);
    try {
      pty.emit(
        [
          'Bash command',
          '  rm -rf build',
          'Do you want to proceed?',
          '\u276f 1. Yes',
          "  2. Yes, and don't ask again for this command",
          '  3. No, and tell Claude what to do differently (esc)',
          '',
          'Esc to cancel',
        ].join('\r\n'),
      );
      await settle();
      expect(m.deliverExternalMessage(id, 'do not approve')).toBe(false);
      expect(m.listPeerSessions().find((p) => p.id === id)?.input_status).toBe('busy');
      expect(pty.writes).toEqual([]);
      // the dialog is answered and cleared: delivery resumes
      pty.emit('\x1b[2J\x1b[H> ');
      await settle();
      expect(m.deliverExternalMessage(id, 'now')).toBe(true);
      const reply = vi.fn();
      m.externalReply = reply;
      expect(
        m.handlePeerRequest({ kind: 'send', from: id, to: 'external:conversation:message', message: 'answer' }).ok,
      ).toBe(true);
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({ id }), 'external:conversation:message', 'answer');
    } finally {
      source.mockRestore();
      m.shutdown();
    }
  });

  it('presses Enter again only when the paste still sits in an idle box', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { m, id, pty } = setup();
    const path = join(home, 'external-landing.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'system', subtype: 'turn_duration' })}\n`);
    const source = vi.spyOn(providerStore, 'storeTranscriptPath').mockReturnValue(path);
    const enters = () => pty.writes.filter((w) => w === '\r').length;
    try {
      expect(
        m.deliverExternalMessage(id, '<cross-session-message from="external:c:m">x</cross-session-message>'),
      ).toBe(true);
      pty.emit('read paste');
      await vi.advanceTimersByTimeAsync(300);
      expect(enters()).toBe(1);
      // nothing visible in the box: never nudge (it could submit someone's typing)
      await vi.advanceTimersByTimeAsync(16_200);
      expect(enters()).toBe(1);
      // the collapsed paste is still in the box: one more Enter
      pty.emit('> [Pasted text #1 +3 lines]');
      await vi.advanceTimersByTimeAsync(8_100);
      pty.emit('x');
      await vi.advanceTimersByTimeAsync(300);
      expect(enters()).toBe(2);
    } finally {
      source.mockRestore();
      m.shutdown();
      vi.useRealTimers();
    }
  });

  it('holds peer input during handoff and refuses a non-running target', () => {
    const { m, id, pty } = setup();
    const sender = m.spawn({
      agentName: 'sender-held',
      role: 'coder',
      workspace: { id: 'ws-s', name: 'proj-s', root: home },
    });
    vi.spyOn(m, 'isHandingOff').mockReturnValue(true);
    m.handlePeerRequest({ kind: 'send', from: sender.sessionId, to: id, message: 'held text' });
    expect(pty.writes).toEqual([]);
    m.shutdown();
    expect(() =>
      m.handlePeerRequest({ kind: 'send', from: sender.sessionId, to: id, message: 'no wake' }),
    ).toThrow();
  });

  it('delivers held peer text to the successor after its first turn', async () => {
    vi.useFakeTimers();
    const { m, id, pty } = setup();
    const sender = m.spawn({
      agentName: 'successor-peer',
      role: 'coder',
      workspace: { id: 'ws-s', name: 'proj-s', root: home },
    });
    vi.spyOn(m, 'isHandingOff').mockImplementation((sid) => sid === id);
    m.handlePeerRequest({
      kind: 'send',
      from: sender.sessionId,
      to: id,
      message: 'survives handoff',
    });
    const successor = m.spawn({
      agentName: 'successor',
      role: 'coder',
      workspace: { id: 'ws-s', name: 'proj-s', root: home },
    });
    const nextPty = ptys.at(-1)!;
    nextPty.writes.length = 0;
    m.emit('replaced', { oldSessionId: id, newSessionId: successor.sessionId });
    m.emit('turn', { sessionId: successor.sessionId });
    await vi.advanceTimersByTimeAsync(1100);
    expect(pty.writes).toEqual([]);
    expect(nextPty.writes[0]).toContain('survives handoff');
    nextPty.emit('read paste');
    await vi.advanceTimersByTimeAsync(250);
    expect(nextPty.writes[1]).toBe('\r');
    m.shutdown();
    vi.useRealTimers();
  });

  it('lists only other live sessions and refuses to wake a hibernated target', () => {
    const { m, id } = setup();
    const target = m.addHibernated({
      projectName: 'proj-s',
      agentName: 'sleeping',
      role: 'coder',
      dir: home,
      claudeSessionId: 'sleeping-id',
    });
    expect(m.handlePeerRequest({ kind: 'list', from: id })).toEqual({ ok: true, sessions: [] });
    const spawn = vi.spyOn(m, 'spawn');
    expect(() =>
      m.handlePeerRequest({ kind: 'send', from: id, to: target.sessionId, message: 'hello' }),
    ).toThrow(/not running/);
    expect(spawn).not.toHaveBeenCalled();
    m.shutdown();
  });

  it('holds the Enter while the TUI has not answered the text', async () => {
    vi.useFakeTimers();
    const { m, id, pty } = setup();
    m.input(id, 'hello');
    m.input(id, '\r');
    await vi.advanceTimersByTimeAsync(2000);
    expect(pty.writes).toEqual(['hello']); // claude is stalled: no Enter yet
    pty.emit('\x1b[2K> hello'); // it finally reads and redraws
    await vi.advanceTimersByTimeAsync(200);
    expect(pty.writes).toEqual(['hello', '\r']);
    m.shutdown();
    vi.useRealTimers();
  });

  it('sends the Enter anyway after the cap when the TUI never answers', async () => {
    vi.useFakeTimers();
    const { m, id, pty } = setup();
    m.input(id, 'hello');
    m.input(id, '\r');
    await vi.advanceTimersByTimeAsync(5100);
    expect(pty.writes).toEqual(['hello', '\r']);
    m.shutdown();
    vi.useRealTimers();
  });

  it('keeps input typed during the wait behind the Enter', async () => {
    vi.useFakeTimers();
    const { m, id, pty } = setup();
    m.input(id, 'first');
    m.input(id, '\r');
    m.input(id, 'second');
    pty.emit('> first');
    await vi.advanceTimersByTimeAsync(200);
    expect(pty.writes).toEqual(['first', '\r', 'second']);
    m.shutdown();
    vi.useRealTimers();
  });

  it('an Enter with nothing typed before it goes at once', () => {
    const { m, id, pty } = setup();
    m.input(id, '\r');
    expect(pty.writes).toEqual(['\r']);
    m.shutdown();
  });

  it.each([
    [
      'Claude model menu',
      [
        'Select model',
        '❯ 1. Default (recommended)',
        '  2. Opus 5.5',
        'Enter to set as default · s to use this session only · Esc to cancel',
      ].join('\r\n'),
    ],
    [
      'Codex model menu',
      [
        'Select Model and Effort',
        '› 1. gpt-5.6-sol (current)',
        '  2. gpt-5.6-terra',
        'Press enter to confirm or esc to go back',
      ].join('\r\n'),
    ],
    [
      'Codex reasoning menu',
      [
        'Select Reasoning Level for gpt-5.6-terra',
        '  1. Low',
        '› 2. Medium (current)',
        'Press enter to confirm or esc to go back',
      ].join('\r\n'),
    ],
  ])('writes Enter immediately for the %s', async (_name, menu) => {
    vi.useFakeTimers();
    const { m, id, pty } = setup();
    try {
      m.input(id, '/model');
      pty.emit(menu);
      await vi.advanceTimersByTimeAsync(30);
      expect(m.deliverExternalMessage(id, 'must not answer the dialog')).toBe(false);

      m.input(id, '\r');

      expect(pty.writes).toEqual(['/model', '\r']);
      const internal = m as unknown as {
        sessions: Map<string, { submittedAt?: number }>;
      };
      expect(internal.sessions.get(id)?.submittedAt).toBeUndefined();
    } finally {
      m.shutdown();
      vi.useRealTimers();
    }
  });

  it('pulls the queue with Up, then empties the box once the TUI has drawn it', async () => {
    vi.useFakeTimers();
    const { m, id, pty } = setup();
    m.pullQueue(id, 5);
    expect(pty.writes).toEqual(['\x1b[A']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pty.writes).toEqual(['\x1b[A']); // nothing drawn yet: wait
    pty.emit('> a\nb');
    await vi.advanceTimersByTimeAsync(200);
    expect(pty.writes).toEqual(['\x1b[A', '\x7f'.repeat(5)]);
    m.shutdown();
    vi.useRealTimers();
  });
});
