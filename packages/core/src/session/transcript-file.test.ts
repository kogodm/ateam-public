import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeProjectDir } from './claude-sessions';
import {
  bashModeRecord,
  claudeCreatedAt,
  claudeLastActiveAt,
  parseTranscriptBlocks,
  parseTranscriptLine,
  transcriptPath,
  transcriptUsage,
  unwrapPasted,
} from './transcript-file';

describe('claudeCreatedAt', () => {
  // claudeProjectDir resolves under the real ~/.claude/projects (not
  // overridable), so write a transcript with a throwaway session id and
  // clean it up. The project dir itself is shared, so only remove our file.
  const cwd = '/Users/test/ateam-createdat-spec';
  const sessionId = `spec-${randomUUID()}`;
  const path = transcriptPath(cwd, sessionId);

  afterEach(() => {
    rmSync(path, { force: true });
  });

  it('returns a valid ISO timestamp when the transcript exists', () => {
    mkdirSync(claudeProjectDir(cwd), { recursive: true });
    writeFileSync(path, '{"type":"summary","summary":"hi"}\n');

    const iso = claudeCreatedAt(cwd, sessionId);
    expect(iso).not.toBe('');
    // round-trips through Date without becoming Invalid Date
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
    expect(iso).toBe(new Date(iso).toISOString());
  });

  it("returns '' when the transcript does not exist", () => {
    expect(claudeCreatedAt(cwd, `absent-${randomUUID()}`)).toBe('');
  });
});

describe('claudeLastActiveAt', () => {
  const cwd = '/Users/test/ateam-lastactive-spec';
  const sessionId = `spec-${randomUUID()}`;
  const path = transcriptPath(cwd, sessionId);

  afterEach(() => {
    rmSync(path, { force: true });
  });

  it('returns the newest timestamped record, ignoring trailing metadata appends', () => {
    mkdirSync(claudeProjectDir(cwd), { recursive: true });
    const ts = '2026-07-01T08:00:00.000Z';
    // resume/quit appends timestamp-less metadata AFTER the last real record
    // (and bumps mtime to "now") — lastActiveAt must still report `ts`.
    writeFileSync(
      path,
      [
        `{"type":"user","timestamp":"2026-06-30T00:00:00.000Z","message":{"role":"user","content":"hi"}}`,
        `{"type":"assistant","timestamp":"${ts}","message":{"role":"assistant","content":"done"}}`,
        `{"type":"agent-name","name":"dack"}`,
        `{"type":"mode","mode":"default"}`,
        `{"type":"last-prompt"}`,
        '',
      ].join('\n'),
    );
    expect(claudeLastActiveAt(cwd, sessionId)).toBe(ts);
  });

  it("returns '' when no record carries a timestamp", () => {
    mkdirSync(claudeProjectDir(cwd), { recursive: true });
    writeFileSync(path, '{"type":"agent-name","name":"dack"}\n');
    expect(claudeLastActiveAt(cwd, sessionId)).toBe('');
  });

  it("returns '' when the transcript does not exist", () => {
    expect(claudeLastActiveAt(cwd, `absent-${randomUUID()}`)).toBe('');
  });
});

describe('transcriptUsage', () => {
  const cwd = '/Users/test/ateam-usage-spec';
  const sessionId = `spec-${randomUUID()}`;
  const path = transcriptPath(cwd, sessionId);

  afterEach(() => {
    rmSync(path, { force: true });
  });

  it('sums usage across assistant records, ignoring other lines', () => {
    mkdirSync(claudeProjectDir(cwd), { recursive: true });
    writeFileSync(
      path,
      [
        `{"type":"user","message":{"role":"user","content":"hi"}}`,
        `{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":100,"cache_read_input_tokens":1000,"cache_creation_input_tokens":50}}}`,
        `{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","usage":{"input_tokens":5,"output_tokens":200,"cache_read_input_tokens":2000,"cache_creation_input_tokens":0}}}`,
        `{"type":"agent-name","name":"dack"}`,
        '',
      ].join('\n'),
    );
    const u = transcriptUsage(cwd, sessionId);
    expect(u).toMatchObject({
      turns: 2,
      inputTokens: 15,
      outputTokens: 300,
      cacheReadTokens: 3000,
      cacheCreationTokens: 50,
      // the second record's model has no price: its tokens are counted
      // above but reported as unpriced, not silently billed at some rate
      unpricedTokens: 2205,
    });
    // opus-5 list price: 10 in @ $5/M + 100 out @ $25/M + 1000 cache read
    // @ $0.5/M + 50 cache write @ $6.25/M
    expect(u.costUsd).toBeCloseTo((10 * 5 + 100 * 25 + 1000 * 0.5 + 50 * 6.25) / 1e6, 9);
  });

  it('returns zeros when the transcript does not exist', () => {
    expect(transcriptUsage(cwd, `absent-${randomUUID()}`)).toEqual({
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      unpricedTokens: 0,
    });
  });
});

describe('parseTranscriptBlocks', () => {
  const line = (msg: unknown): string =>
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-25T10:00:00Z', message: msg });

  it('splits a mixed message into block-level turns', () => {
    const turns = parseTranscriptBlocks(
      line({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me check' },
          { type: 'text', text: 'looking now' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
        ],
      }),
      's1',
      10,
    );
    expect(turns.map((t) => t.kind)).toEqual(['thinking', 'text', 'tool_use']);
    expect(turns.map((t) => t.seq)).toEqual([10, 11, 12]);
    expect(turns[2]?.toolName).toBe('Bash');
    expect(turns[2]?.text).toBe('ls -la');
  });

  it('extracts text out of an array-shaped tool_result', () => {
    const turns = parseTranscriptBlocks(
      line({
        role: 'user',
        content: [{ type: 'tool_result', content: [{ type: 'text', text: 'total 8\nfoo' }] }],
      }),
      's1',
      0,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe('tool');
    expect(turns[0]?.kind).toBe('tool_result');
    expect(turns[0]?.text).toBe('total 8\nfoo');
  });

  it('keeps a plain user message a user turn', () => {
    const turns = parseTranscriptBlocks(line({ role: 'user', content: '你好' }), 's1', 0);
    expect(turns[0]?.role).toBe('user');
    expect(turns[0]?.kind).toBe('text');
    expect(turns[0]?.injected).toBeUndefined();
  });

  it('marks only the complete, pasted or block-shaped handoff prompt as injected', () => {
    const handoff = [
      'I am taking over from a previous session that hit the context limit.',
      '',
      '--- HANDOFF ---',
      'Pick up the work from here.',
      '--- END HANDOFF ---',
    ].join('\n');
    const pasted = `<pasted_content id="handoff">\n${handoff}\n</pasted_content id="handoff">`;
    expect(
      parseTranscriptBlocks(line({ role: 'user', content: pasted }), 's1', 0)[0],
    ).toMatchObject({ role: 'user', text: handoff, injected: 'handoff' });
    expect(
      parseTranscriptBlocks(
        line({ role: 'user', content: [{ type: 'text', text: pasted }] }),
        's1',
        0,
      )[0],
    ).toMatchObject({ role: 'user', text: handoff, injected: 'handoff' });
    expect(
      parseTranscriptBlocks(
        line({ role: 'user', content: `Please process this: ${handoff}` }),
        's1',
        0,
      )[0]?.injected,
    ).toBeUndefined();
    expect(
      parseTranscriptBlocks(
        line({ role: 'user', content: `${handoff}\n--- END HANDOFF ---` }),
        's1',
        0,
      )[0]?.injected,
    ).toBeUndefined();
    expect(
      parseTranscriptBlocks(
        line({ role: 'user', content: `${handoff}\ntrailing text` }),
        's1',
        0,
      )[0]?.injected,
    ).toBeUndefined();
  });
});

describe('tool calls', () => {
  it("a Bash call carries claude's own name for it as label", () => {
    const t = parseTranscriptBlocks(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: {
                command: 'python count.py | tail -5',
                description: 'Count to 20 with a tqdm progress bar',
              },
            },
          ],
        },
      }),
      's1',
      0,
    );
    expect(t[0]).toMatchObject({
      kind: 'tool_use',
      text: 'python count.py | tail -5',
      label: 'Count to 20 with a tqdm progress bar',
    });
  });
});

describe('API errors', () => {
  it("claude's synthetic API-error record is a notice", () => {
    const t = parseTranscriptBlocks(
      JSON.stringify({
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'API Error: 529 overloaded' }],
        },
      }),
      's1',
      0,
    );
    expect(t).toMatchObject([
      { role: 'assistant', notice: 'error', text: 'API Error: 529 overloaded' },
    ]);
  });
});

describe('queued (mid-turn) messages', () => {
  it('surfaces an enqueue op as a user turn', () => {
    const turns = parseTranscriptBlocks(
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-08-25T14:31:00Z',
        content: '回车以后没有自动收键盘',
      }),
      's1',
      5,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe('user');
    expect(turns[0]?.text).toBe('回车以后没有自动收键盘');
  });

  it('marks an enqueued message queued and its release dequeued', () => {
    const enq = parseTranscriptBlocks(
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '排队的话' }),
      's1',
      0,
    );
    expect(enq[0]?.queued).toBe(true);
    expect(enq[0]?.dequeued).toBeUndefined();
    const rem = parseTranscriptBlocks(
      JSON.stringify({ type: 'queue-operation', operation: 'remove', content: '排队的话' }),
      's1',
      1,
    );
    expect(rem[0]?.dequeued).toBe(true);
    expect(rem[0]?.text).toBe('排队的话');
  });

  it('a dequeue (no text) is a marker: the oldest queued message was taken', () => {
    const t = parseTranscriptBlocks(
      JSON.stringify({ type: 'queue-operation', operation: 'dequeue', timestamp: 't' }),
      's1',
      0,
    );
    expect(t).toMatchObject([{ role: 'user', text: '', dequeued: true }]);
  });

  it('a queued_command attachment is the message entering the conversation mid-turn', () => {
    const line = (prompt: unknown) =>
      JSON.stringify({
        type: 'attachment',
        timestamp: 't',
        attachment: { type: 'queued_command', prompt },
      });
    expect(parseTranscriptBlocks(line('改一下标题'), 's1', 0)).toMatchObject([
      { role: 'user', kind: 'text', text: '改一下标题', injected: 'mid_turn' },
    ]);
    expect(parseTranscriptBlocks(line([{ type: 'text', text: '带图的' }]), 's1', 0)[0]?.text).toBe(
      '带图的',
    );
    expect(parseTranscriptBlocks(line('  '), 's1', 0)).toHaveLength(0);
    const handoff = [
      'I am taking over from a previous session that hit the context limit.',
      '',
      '--- HANDOFF ---',
      'Pick up the work from here.',
      '--- END HANDOFF ---',
    ].join('\n');
    expect(parseTranscriptBlocks(line(handoff), 's1', 0)[0]?.injected).toBe('handoff');
    // pasted in while the session was busy: the paste shell comes off, so a
    // message Ateam typed still reads as Ateam's
    expect(
      parseTranscriptBlocks(
        line('<pasted_content id="a5c4">\n[Ateam — experience checkpoint]\n\nsave</pasted_content id="a5c4">'),
        's1',
        0,
      )[0]?.text,
    ).toBe('[Ateam — experience checkpoint]\n\nsave');
    const other = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success' } });
    expect(parseTranscriptBlocks(other, 's1', 0)).toHaveLength(0);
  });

  it('does not mark queue-operation records as injected', () => {
    const t = parseTranscriptBlocks(
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '我输入的内容' }),
      's1',
      0,
    )[0];
    expect(t?.queued).toBe(true);
    expect(t?.injected).toBeUndefined();
  });

  it('popAll (pulled back to edit) is a release marker like remove', () => {
    const t = parseTranscriptBlocks(
      JSON.stringify({ type: 'queue-operation', operation: 'popAll', content: '改一下' }),
      's1',
      0,
    );
    expect(t).toMatchObject([{ text: '改一下', dequeued: true }]);
  });

  it('ignores unknown ops and empty enqueues', () => {
    for (const rec of [
      { type: 'queue-operation', operation: 'reorder', content: 'x' },
      { type: 'queue-operation', operation: 'enqueue', content: '  ' },
    ]) {
      expect(parseTranscriptBlocks(JSON.stringify(rec), 's1', 0)).toHaveLength(0);
    }
  });
});

describe('unwrapPasted', () => {
  it("keeps what the user wrote, not claude's paste wrapper (09-20)", () => {
    const rec =
      '\n\n<pasted_content id="c40d">\nflux的重绘 好像把原图变模糊了\n</pasted_content id="c40d">\n';
    expect(unwrapPasted(rec.trim())).toBe('flux的重绘 好像把原图变模糊了');
    expect(unwrapPasted('<pasted_content id="a1">\nline 1\nline 2\n</pasted_content>')).toBe(
      'line 1\nline 2',
    );
    expect(unwrapPasted('plain words')).toBe('plain words');
    expect(unwrapPasted('about <pasted_content> tags')).toBe('about <pasted_content> tags');
  });
});

describe('bashModeRecord', () => {
  it('reads claude bash mode as a command and its output (color, 09-20)', () => {
    expect(
      bashModeRecord("<bash-input> ssh dep3@10.10.10.54 'npx pm2 restart x'</bash-input>"),
    ).toEqual({
      kind: 'input',
      text: "ssh dep3@10.10.10.54 'npx pm2 restart x'",
    });
    expect(
      bashModeRecord(
        '<bash-stdout>id | name\n10 | color-level-manager</bash-stdout><bash-stderr></bash-stderr>',
      ),
    ).toEqual({ kind: 'output', text: 'id | name\n10 | color-level-manager' });
    expect(
      bashModeRecord('<bash-stdout>ok</bash-stdout><bash-stderr>warn: x</bash-stderr>'),
    ).toEqual({
      kind: 'output',
      text: 'ok\nwarn: x',
    });
    expect(bashModeRecord('what does <bash-input> do?')).toBeNull();
  });
  it('turns those records into a tool card and its result', () => {
    const rec = (text: string) =>
      JSON.stringify({
        type: 'user',
        timestamp: '2026-09-20T06:00:00Z',
        message: { role: 'user', content: text },
      });
    const turns = [
      ...parseTranscriptBlocks(rec('<bash-input>pm2 list</bash-input>'), 's', 0),
      ...parseTranscriptBlocks(
        rec('<bash-stdout>online</bash-stdout><bash-stderr></bash-stderr>'),
        's',
        1,
      ),
    ];
    expect(turns.map((t) => [t.role, t.kind, t.toolName, t.text])).toEqual([
      ['tool', 'tool_use', 'Bash', 'pm2 list'],
      ['tool', 'tool_result', undefined, 'online'],
    ]);
  });
});

describe('queued messages', () => {
  it('unwraps a pasted queue entry so the tray still knows it is the user (09-21)', () => {
    const rec = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-09-21T02:29:07.905Z',
      content:
        '<pasted_content id="c40d">\n每关的 1:1 八列对比图在 .66 的 /tmp/gptprod\n</pasted_content id="c40d">',
    });
    const [turn] = parseTranscriptBlocks(rec, 's', 0);
    expect(turn?.queued).toBe(true);
    expect(turn?.text).toBe('每关的 1:1 八列对比图在 .66 的 /tmp/gptprod');
  });
});

describe('the change a tool made', () => {
  const result = (toolUseResult: unknown): string =>
    JSON.stringify({
      type: 'user',
      timestamp: '2026-09-21T10:00:00.000Z',
      toolUseResult,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }],
      },
    });

  it('reads an Edit as one file of hunks', () => {
    const [turn] = parseTranscriptBlocks(
      result({
        filePath: '/w/a.ts',
        structuredPatch: [{ oldStart: 3, newStart: 3, lines: [' keep', '-gone', '+new'] }],
      }),
      's',
      0,
    );
    expect(turn?.patch).toEqual([
      { file: '/w/a.ts', hunks: [{ oldStart: 3, newStart: 3, lines: [' keep', '-gone', '+new'] }] },
    ]);
  });

  it('shows a created file as its content, which has no diff to record', () => {
    const [turn] = parseTranscriptBlocks(
      result({
        type: 'create',
        filePath: '/w/new.txt',
        content: 'one\ntwo\n',
        structuredPatch: [],
      }),
      's',
      0,
    );
    expect(turn?.patch).toEqual([
      { file: '/w/new.txt', hunks: [{ oldStart: 0, newStart: 1, lines: ['+one', '+two'] }] },
    ]);
  });

  it('reads the diff a bash command left, one entry per file it edited', () => {
    const [turn] = parseTranscriptBlocks(
      result({
        stdout: '',
        bashEditDiff: {
          files: [
            { filePath: '/w/a.txt', hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }] },
            { filePath: '/w/b.txt', hunks: [{ oldStart: 2, newStart: 2, lines: ['+c'] }] },
          ],
        },
      }),
      's',
      0,
    );
    expect(turn?.patch?.map((p) => p.file)).toEqual(['/w/a.txt', '/w/b.txt']);
  });

  it('counts what the cap left out instead of ending mid-file', () => {
    const content = `${Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const [turn] = parseTranscriptBlocks(
      result({ type: 'create', filePath: '/w/big.txt', content, structuredPatch: [] }),
      's',
      0,
    );
    expect(turn?.patch?.[0]?.hunks[0]?.lines.length).toBe(400);
    expect(turn?.patch?.[0]?.dropped).toBe(100);
  });

  it('leaves a result that changed nothing without a patch', () => {
    const [turn] = parseTranscriptBlocks(result({ stdout: 'hi', stderr: '' }), 's', 0);
    expect(turn?.patch).toBeUndefined();
  });
});

describe('what the harness injected', () => {
  const meta = (text: string, isMeta = true): string =>
    JSON.stringify({
      type: 'user',
      isMeta,
      timestamp: '2026-09-22T02:00:00.000Z',
      message: { role: 'user', content: text },
    });

  it('marks a record the harness wrote, so it is not shown as the person talking', () => {
    const [turn] = parseTranscriptBlocks(
      meta(
        'Your response above was stopped by a safety classifier — this is not a tool or API error.',
      ),
      's',
      0,
    );
    expect(turn?.role).toBe('user');
    expect(turn?.meta).toBe(true);
  });

  it('leaves what the person actually typed unmarked', () => {
    const [turn] = parseTranscriptBlocks(meta('打个正式包', false), 's', 0);
    expect(turn?.meta).toBeUndefined();
  });

  it('marks it through a block list too, not only a plain string', () => {
    const rec = JSON.stringify({
      type: 'user',
      isMeta: true,
      timestamp: '2026-09-22T02:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Continue from where you left off.' }],
      },
    });
    expect(parseTranscriptBlocks(rec, 's', 0)[0]?.meta).toBe(true);
  });
});

describe('a message sent with a picture', () => {
  it('unwraps the paste in a BLOCK list too, not only in a plain string', () => {
    // a picture makes claude store the message as blocks; the paste wrapper
    // used to survive there and the bubble showed the tags
    const rec = JSON.stringify({
      type: 'user',
      timestamp: '2026-09-22T03:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '[Image #4]\n\n<pasted_content id="5a0f">\n反馈说是两个区域的像素列表有重复\n</pasted_content id="5a0f">\n',
          },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } },
        ],
      },
    });
    const [turn] = parseTranscriptBlocks(rec, 's', 0);
    expect(turn?.text).toBe('[Image #4]\n\n反馈说是两个区域的像素列表有重复');
  });
});

describe('api-request-blob records', () => {
  // Claude Code 2.1.300 snapshots each API request as a message-shaped record.
  const blob = JSON.stringify({
    type: 'api-request-blob',
    sessionId: 's',
    hash: 'abc',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        {
          type: 'text',
          text: 'The user sent a new message while you were working:\nhello\n\nThis is how Claude Code surfaces messages.',
        },
      ],
    },
  });

  it('are not conversation: no user bubble, no repeated tool cards', () => {
    expect(parseTranscriptBlocks(blob, 's', 0)).toEqual([]);
    expect(parseTranscriptLine(blob, 's', 0)).toBeUndefined();
  });
});

describe("Claude's compaction summary", () => {
  const SUMMARY =
    'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.';
  const record = (content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'user',
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      timestamp: '2026-10-19T04:00:00Z',
      message: { role: 'user', content },
      ...extra,
    });

  it("is an injected compaction card, not the person's bubble", () => {
    const [turn] = parseTranscriptBlocks(record(SUMMARY), 's', 0);
    expect(turn?.role).toBe('user');
    expect(turn?.injected).toBe('compaction');
    expect(turn?.text).toBe(SUMMARY);
  });

  it('is one too when the summary is stored as a block list', () => {
    const turns = parseTranscriptBlocks(record([{ type: 'text', text: SUMMARY }]), 's', 0);
    expect(turns.map((t) => t.injected)).toEqual(['compaction']);
  });

  it('leaves the same words typed by the person alone', () => {
    const typed = JSON.stringify({
      type: 'user',
      timestamp: '2026-10-19T04:00:00Z',
      message: { role: 'user', content: SUMMARY },
    });
    const [turn] = parseTranscriptBlocks(typed, 's', 0);
    expect(turn?.injected).toBeUndefined();
  });
});
