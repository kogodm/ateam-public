import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  progressBySource,
  unannouncedTask,
  backgroundCommand,
  backgroundTask,
  commandLabel,
  liveTarget,
  outputFiles,
  pendingBashTask,
  progressOf,
  redirectTargets,
  sessionTask,
  taskEnded,
  writingLine,
} from './bg-progress';

const dir = mkdtempSync(join(tmpdir(), 'bg-progress-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('redirectTargets', () => {
  it('finds stdout redirects and tee, relative to cwd or a leading cd', () => {
    expect(
      redirectTargets(
        './migrations/run_stock.sh > migrations/run_stock.log 2>&1; ./migrations/run_phase2.sh > migrations/run_phase2.log 2>&1',
        '/p/color',
      ),
    ).toEqual(['/p/color/migrations/run_stock.log', '/p/color/migrations/run_phase2.log']);
    expect(redirectTargets('cd /srv/app && make 2>&1 | tee -a build.log', '/p')).toEqual([
      '/srv/app/build.log',
    ]);
    expect(redirectTargets('cd sub && ./x >> "out file.log"', '/p')).toEqual([
      '/p/sub/out file.log',
    ]);
  });
  it('expands the variables a session names its log with (09-15: LOG=…; … > $LOG)', () => {
    const scratch = '/private/tmp/claude-501/p/s/scratchpad';
    expect(
      redirectTargets(
        `LOG=${scratch}/countdown30.log\nfor i in $(seq 1 30); do echo "进度 $i/30"; sleep 1; done > $LOG 2>&1; echo "done" >> $LOG; tail -1 $LOG`,
        '/p',
      ),
    ).toEqual([`${scratch}/countdown30.log`]);
    expect(
      redirectTargets(
        `V=${scratch}\n$V/venv/bin/python -u -c "print(1)" > $V/tqdm20.log 2>&1; cat $V/tqdm20.log`,
        '/p',
      ),
    ).toEqual([`${scratch}/tqdm20.log`]);
    expect(redirectTargets('D="/srv/app"; cd $D && make > ${D}/build.log', '/p')).toEqual([
      '/srv/app/build.log',
    ]);
    expect(redirectTargets('./x > ~/logs/x.log', '/p')[0]).toMatch(/^\/.+\/logs\/x\.log$/);
    expect(redirectTargets('./x > $UNSET/x.log', '/p')).toEqual([]);
  });

  it('ignores stderr-only redirects, /dev/null and fd duplication', () => {
    expect(redirectTargets('make 2> err.log >/dev/null 2>&1', '/p')).toEqual([]);
    expect(redirectTargets('pnpm test', '/p')).toEqual([]);
  });
});

describe('outputFiles', () => {
  it('finds what a silent curl / wget is filling (09-15: curl -sL -o …7z)', () => {
    const D = '/private/tmp/claude-501/x/s/scratchpad';
    const cmd = `D=${D}; cd $D && curl -sL -C - -m 3600 -o ComfyUI_windows_portable_nvidia_v0.35.0.7z "https://github.com/x.7z" && curl -sL -m 600 -o ComfyUI-v0.35.2.tar.gz "https://github.com/y.tar.gz" && ls -l a b && echo MAC_DL_DONE`;
    expect(outputFiles(cmd, '/p')).toEqual([
      `${D}/ComfyUI_windows_portable_nvidia_v0.35.0.7z`,
      `${D}/ComfyUI-v0.35.2.tar.gz`,
    ]);
    expect(outputFiles('wget -q -O /tmp/a.iso https://x/a.iso', '/p')).toEqual(['/tmp/a.iso']);
    expect(outputFiles('curl -fsSLo out.bin https://x', '/w')).toEqual(['/w/out.bin']);
  });
  it('ignores -o of other tools and stdout', () => {
    expect(outputFiles('gcc -o app main.c; curl -o - https://x', '/p')).toEqual([]);
  });
  it('writingLine names the latest file and its size', () => {
    expect(writingLine([{ path: '/a/big.7z', bytes: 851_968_000 }])).toBe(
      'Writing big.7z · 812.5 MB',
    );
    expect(writingLine([{ path: '/a/b.gz', bytes: 3_500_000_000 }])).toBe('Writing b.gz · 3.26 GB');
    expect(writingLine([])).toBe('');
  });
});

describe('progressOf', () => {
  it('reads the last N/M in the tail, with the percentage it implies', () => {
    const log =
      '=== 13:54:33 开始 migrations/x.plan.json\n进度 120/6040（20s）\n进度 2310/6040（812s）\n';
    expect(progressOf(log)).toEqual({
      progress: { done: 2310, total: 6040, pct: 38.2 },
      lastLine: '', // the progress line itself — already shown as the figure
    });
  });
  it('keeps a last line that says something the figure does not', () => {
    expect(progressOf('进度 30/30\n=== 开始 migrations/next.plan.json\n')).toEqual({
      progress: { done: 30, total: 30, pct: 100 },
      lastLine: '=== 开始 migrations/next.plan.json',
    });
  });

  it('reads tqdm redraws and plain percentages', () => {
    expect(progressOf('train:  10%|█  | 10/100\rtrain:  45%|████ | 45/100').progress).toEqual({
      done: 45,
      total: 100,
      pct: 45,
    });
    expect(progressOf('downloading... 73.5%\n').progress).toEqual({ pct: 73.5 });
  });
  it('does not mistake dates, paths or ratios above 1 for progress', () => {
    expect(
      progressOf('mkdir 3_svgs/2026-02/3 locked (423)\nat 2026/09/15 13:54').progress,
    ).toBeUndefined();
    expect(progressOf('scored 9/4 on retry').progress).toBeUndefined();
  });
  it('skips the exit marker when picking the last line', () => {
    expect(progressOf('all files moved\n[exited with code 0]\n').lastLine).toBe('all files moved');
  });
});

describe('backgroundCommand + liveTarget', () => {
  it('finds the command a task id was started with', () => {
    const t = join(dir, 's.jsonl');
    writeFileSync(
      t,
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'Bash',
                input: {
                  command: './run.sh > run.log 2>&1',
                  description: 'Migrate the colour folders',
                  run_in_background: true,
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content:
                  'Command running in background with ID: bx1y2z3. Output is being written to: /tmp/x',
              },
            ],
          },
        }),
      ].join('\n'),
    );
    expect(backgroundCommand(t, 'bx1y2z3')).toBe('./run.sh > run.log 2>&1');
    expect(backgroundTask(t, 'bx1y2z3')?.description).toBe('Migrate the colour folders');
    expect(backgroundCommand(t, 'unknown')).toBeUndefined();
  });
  it('knows a Monitor from the command it watches, as the transcript grows (color, 09-15)', () => {
    const t = join(dir, 'monitor.jsonl');
    const call = (id: string, name: string, command: string, description: string) =>
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name, input: { command, description } }] },
      });
    const answer = (id: string, text: string) =>
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
      });
    // a Bash and a Monitor in ONE assistant message, answered after both
    writeFileSync(
      t,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            JSON.parse(call('u1', 'Bash', 'python train.py > $D/train.log 2>&1', 'Run grouped CV'))
              .message.content[0],
            JSON.parse(call('u2', 'Monitor', 'tail -f $D/train.log | grep auc', 'CV results'))
              .message.content[0],
          ],
        },
      })}\n${answer('u1', 'Command running in background with ID: bjjfb1h4t. Output is being written to: /tmp/x')}\n`,
    );
    expect(backgroundTask(t, 'bjjfb1h4t')).toEqual({
      command: 'python train.py > $D/train.log 2>&1',
      description: 'Run grouped CV',
    });
    expect(backgroundTask(t, 'b1kx4pb5u')).toBeUndefined();
    appendFileSync(t, `${answer('u2', 'Monitor started (task b1kx4pb5u, expires in 30m)')}\n`);
    expect(backgroundTask(t, 'b1kx4pb5u')).toEqual({
      command: 'tail -f $D/train.log | grep auc',
      description: 'CV results',
      monitor: true,
    });
    // a half-written line is picked up once it is finished
    const line = call('u3', 'Bash', 'sleep 99', 'Wait');
    appendFileSync(t, line.slice(0, 20));
    appendFileSync(
      t,
      `${line.slice(20)}\n${answer('u3', 'Command running in background with ID: bzzz111')}\n`,
    );
    expect(backgroundTask(t, 'bzzz111')?.description).toBe('Wait');
    // a foreground command that hit its timeout is announced another way
    appendFileSync(t, `${call('u4', 'Bash', 'python slow.py', 'Slow')}\n`);
    appendFileSync(
      t,
      `${answer('u4', 'Command did not complete within its 120s timeout and was moved to the background (ID: b0j90aiu7). Output is being written to: /tmp/x')}\n`,
    );
    expect(backgroundTask(t, 'b0j90aiu7')?.description).toBe('Slow');
  });
  it('an unannounced task is the Bash call still waiting for its result', () => {
    const t = join(dir, 'pending.jsonl');
    const use = (id: string, command: string, description: string) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description } }],
        },
      });
    const result = (id: string) =>
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      });
    writeFileSync(
      t,
      [
        use('t1', 'ls', 'List'),
        result('t1'),
        use('t2', 'python count.py > $V/c.log 2>&1', 'Count to 20'),
      ].join('\n'),
    );
    expect(pendingBashTask(t)).toEqual({
      command: 'python count.py > $V/c.log 2>&1',
      description: 'Count to 20',
    });
    writeFileSync(t, [use('t1', 'ls', 'List'), result('t1')].join('\n'));
    expect(pendingBashTask(t)).toBeUndefined();
  });

  it('picks the most recently written existing target', () => {
    const a = join(dir, 'a.log');
    const b = join(dir, 'b.log');
    writeFileSync(a, 'a');
    writeFileSync(b, 'b');
    utimesSync(a, new Date(), new Date(Date.now() - 60_000));
    expect(liveTarget([a, b, join(dir, 'missing.log')])).toBe(b);
  });
});

describe('commandLabel', () => {
  it('names a command claude gave no description (color, 09-17)', () => {
    expect(
      commandLabel(
        '/Users/sample/PycharmProjects/demo1/jobs_2026_2027/output_checks/scripts/run_all_proxy.sh > /Users/sample/PycharmProjects/demo1/jobs_2026_2027/output_checks/run_all_proxy.log 2>&1',
      ),
    ).toBe('run_all_proxy.sh');
    expect(
      commandLabel('cd /srv/app && LOG=/tmp/x.log; python3 tools/train.py --epochs 3 > $LOG 2>&1'),
    ).toBe('python3 train.py --epochs 3');
    expect(commandLabel('npm run build 2>&1 | tee build.log')).toBe('npm run build');
  });
});

describe('sessionTask', () => {
  it("finds tasks a sub-agent started, in the sub-agent's own log (color, 09-17)", () => {
    const t = join(dir, 'parent.jsonl');
    writeFileSync(t, '');
    mkdirSync(join(dir, 'parent', 'subagents'), { recursive: true });
    const lines = [
      [
        'u1',
        'Bash',
        './run_all_proxy.sh > run.log 2>&1',
        'Command running in background with ID: bnpd025ee. Output…',
      ],
      [
        'u2',
        'Monitor',
        'tail -f run.log | grep DONE',
        'Monitor started (task bi73y4hrg, expires in 30m)',
      ],
    ].flatMap(([id, name, command, result]) => [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name, input: { command } }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] },
      }),
    ]);
    writeFileSync(join(dir, 'parent', 'subagents', 'agent-a1.jsonl'), `${lines.join('\n')}\n`);
    expect(backgroundTask(t, 'bnpd025ee')).toBeUndefined();
    expect(sessionTask(t, 'bnpd025ee')).toMatchObject({
      command: './run_all_proxy.sh > run.log 2>&1',
      bySubagent: true,
    });
    expect(sessionTask(t, 'bi73y4hrg')?.monitor).toBe(true);
  });
});

describe('taskEnded', () => {
  const notice = (id: string, extra: string) =>
    `<task-notification>\n<task-id>${id}</task-id>\n${extra}\n</task-notification>`;
  const user = (text: string) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const queued = (text: string) =>
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: text });

  it("a Monitor's events are not its end; the notice with a status is (09-22)", () => {
    const t = join(dir, 'monitor.jsonl');
    writeFileSync(
      t,
      `${[
        queued(
          notice(
            'bmon1',
            '<summary>Monitor event: ".66 上 240 关出图进度"</summary>\n<event>[.66] 120/240</event>',
          ),
        ),
        user(
          notice(
            'bmon1',
            '<summary>Monitor event: ".66 上 240 关出图进度"</summary>\n<event>[.66] 120/240</event>',
          ),
        ),
      ].join('\n')}\n`,
    );
    expect(taskEnded(t, 'bmon1')).toBe(false);
    appendFileSync(
      t,
      `${queued(notice('bmon1', '<status>completed</status>\n<summary>Monitor ".66 上 240 关出图进度" stream ended</summary>'))}\n`,
    );
    expect(taskEnded(t, 'bmon1')).toBe(true);
  });

  it('takes every terminal status, and only for the task it names', () => {
    const t = join(dir, 'statuses.jsonl');
    writeFileSync(
      t,
      `${['stopped', 'failed', 'killed']
        .map((st, i) => user(notice(`bx${i}`, `<status>${st}</status>`)))
        .join('\n')}\n`,
    );
    expect([0, 1, 2].map((i) => taskEnded(t, `bx${i}`))).toEqual([true, true, true]);
    expect(taskEnded(t, 'bother')).toBe(false);
  });

  it('one notice can end many tasks at once — a restart stops every watcher (09-23)', () => {
    const t = join(dir, 'batch.jsonl');
    writeFileSync(
      t,
      `${user('<task-notification>\n<task-id>bw1</task-id>\n<task-id>bw2</task-id>\n<task-id>bw3</task-id>\n<status>stopped</status>\n</task-notification>')}\n`,
    );
    expect(['bw1', 'bw2', 'bw3'].map((id) => taskEnded(t, id))).toEqual([true, true, true]);
  });

  it('TaskStop writes no notice — its result is the end', () => {
    const t = join(dir, 'taskstop.jsonl');
    writeFileSync(
      t,
      `${JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_9',
              content:
                '{"message":"Successfully stopped task: b7fg6b321 (while true; do sleep 900; …)"}',
            },
          ],
        },
      })}\n`,
    );
    expect(taskEnded(t, 'b7fg6b321')).toBe(true);
  });

  it("does not take a notice quoted in the model's own words", () => {
    const t = join(dir, 'quoted.jsonl');
    writeFileSync(
      t,
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: notice('bq1', '<status>completed</status>') }] },
      })}\n`,
    );
    expect(taskEnded(t, 'bq1')).toBe(false);
  });
});

describe('unannouncedTask (09-30)', () => {
  const root = mkdtempSync(join(tmpdir(), 'unannounced-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const bash = (id: string, at: string, description: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: at,
      message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 99', description } }] },
    });
  const result = (id: string) =>
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
  const transcript = join(root, 'sess.jsonl');
  mkdirSync(join(root, 'sess', 'subagents'), { recursive: true });
  // the session's own pending call is older; the sub-agent's is a second before the file
  writeFileSync(transcript, `${bash('p1', '2026-09-30T02:10:00Z', 'parent wait')}\n`);
  writeFileSync(
    join(root, 'sess', 'subagents', 'agent-x.jsonl'),
    `${bash('s0', '2026-09-30T02:17:00Z', 'done one')}\n${result('s0')}\n${bash('s1', '2026-09-30T02:17:34Z', 'Block until runs finish')}\n`,
  );

  it('matches a task file to the pending call it was born a moment after', () => {
    const t = unannouncedTask(transcript, Date.parse('2026-09-30T02:17:35Z'));
    expect(t).toMatchObject({ description: 'Block until runs finish', bySubagent: true });
    expect(t?.agentLog).toContain('agent-x.jsonl');
  });
  it("never lends the session's pending call to a task born long after it", () => {
    expect(unannouncedTask(transcript, Date.parse('2026-09-30T02:30:00Z'))).toBeUndefined();
    expect(unannouncedTask(transcript, Date.parse('2026-09-30T02:10:01Z'))?.description).toBe(
      'parent wait',
    );
  });
});

describe('progressBySource (09-30)', () => {
  const out = [
    'tmp_fill956_pkg/upload_levels.log:进度 850/881 ok=832 fail=18',
    'tmp_fill956_pkg/upload_levels.log:进度 881/881 ok=863 fail=18',
    'tmp_fill956/progress.log:2026-09-30 10:19:28 进度 300/528 失败 0 已用 16.7 分',
    'tmp_fill956_pkg/upload_levels.log:进度 50/863 bad=0',
    'tmp_fill956/progress.log:2026-09-30 10:21:48 进度 340/528 失败 0 已用 19.0 分',
    'tmp_fill956_pkg/upload_levels.log:失败 idid9e: Could not connect to "https://x.s3.amazonaws.com/a.zip"',
  ].join('\n');

  it('keeps each log its own figure instead of one that jumps between them', () => {
    const src = progressBySource(out);
    expect(src.map((s) => [s.source, s.progress.done, s.progress.total])).toEqual([
      ['tmp_fill956/progress.log', 340, 528],
      ['tmp_fill956_pkg/upload_levels.log', 50, 863],
    ]);
  });
  it('the prefix comes off, so the timestamp behind it still dates the line', () => {
    const src = progressBySource(out).find((s) => s.source === 'tmp_fill956/progress.log');
    expect(src?.text.split('\n')[0]).toMatch(/^2026-09-30 10:19:28/);
  });
  it('plain output and URLs are not sources', () => {
    expect(progressBySource('进度 3/10\nhttps://a.com/x.js: 5/9')).toEqual([]);
  });
});
