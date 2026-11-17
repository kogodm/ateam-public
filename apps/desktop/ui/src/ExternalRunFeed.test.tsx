import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ExternalRunDTO } from '@ateam/contract';
import { ExternalRunCard, mergeExternalRunUpdates } from './ExternalRunFeed';

function run(overrides: Partial<ExternalRunDTO> = {}): ExternalRunDTO {
  return {
    executionId: 'exec-1',
    sessionId: 'session-a',
    tool: 'run_command',
    command: 'printf "first\\nsecond"',
    status: 'running',
    exitCode: null,
    startedAt: '2026-10-15T10:00:00.000Z',
    endedAt: null,
    output: 'first\nsecond\n',
    truncated: false,
    ...overrides,
  };
}

describe('ExternalRunFeed helpers and card', () => {
  it('updates one execution from running to exited and keeps the live state over late history', () => {
    const running = run();
    const exited = run({ status: 'exited', exitCode: 0, endedAt: '2026-10-15T10:00:01.000Z' });
    const live = mergeExternalRunUpdates([], [running], { incomingWins: true });
    const updated = mergeExternalRunUpdates(live, [exited], { incomingWins: true });
    const afterLateHistory = mergeExternalRunUpdates(updated, [running]);
    expect(updated).toHaveLength(1);
    expect(afterLateHistory[0]).toMatchObject({ status: 'exited', exitCode: 0 });
  });

  it('filters other sessions, sorts by start time and retains only the latest 20', () => {
    const history = Array.from({ length: 22 }, (_, i) => run({
      executionId: `exec-${i}`,
      startedAt: `2026-10-15T10:${String(i).padStart(2, '0')}:00.000Z`,
    }));
    const merged = mergeExternalRunUpdates([], [...history, run({ executionId: 'other', sessionId: 'session-b' })], {
      sessionId: 'session-a',
    });
    expect(merged).toHaveLength(20);
    expect(merged[0]?.executionId).toBe('exec-2');
    expect(merged.at(-1)?.executionId).toBe('exec-21');
    expect(merged.every((item) => item.sessionId === 'session-a')).toBe(true);
  });

  it('renders a neutral expandable card with command, status and preserved output lines', () => {
    const fullCommand = `printf '<safe & sound>' && ${'x'.repeat(160)}\nprintf second-line`;
    const summary = `${fullCommand.replace(/\s+/g, ' ').trim().slice(0, 137)}…`;
    const markup = renderToStaticMarkup(
      <ExternalRunCard run={run({ command: fullCommand, truncated: true })} />,
    );
    expect(markup).toContain('MCP · run_command');
    expect(markup).toContain('<details class="external-run-card" open="">');
    expect(markup).toContain('Running…');
    expect(markup).toContain('Tail only');
    expect(markup).toContain('<pre>first\nsecond\n</pre>');
    expect(markup).toContain(
      renderToStaticMarkup(<code className="external-run-command" title={fullCommand}>{summary}</code>),
    );
    expect(markup).toContain(
      renderToStaticMarkup(
        <pre className="external-run-command-full" aria-label="Full command">{fullCommand}</pre>,
      ),
    );

    const failed = renderToStaticMarkup(
      <ExternalRunCard run={run({ status: 'timed_out', endedAt: '2026-10-15T10:01:00.000Z' })} />,
    );
    expect(failed).toContain('external-run-status is-failed');
    expect(failed).toContain('timed out');
  });
});
