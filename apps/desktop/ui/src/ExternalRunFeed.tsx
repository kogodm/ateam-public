import { useEffect, useRef, useState } from 'react';
import type { ExternalRunDTO } from '@ateam/contract';
import type { Rpc } from './rpc';

export function mergeExternalRunUpdates(
  current: readonly ExternalRunDTO[],
  incoming: readonly ExternalRunDTO[],
  options: { sessionId?: string; incomingWins?: boolean } = {},
): ExternalRunDTO[] {
  const byId = new Map<string, ExternalRunDTO>();
  const add = (run: ExternalRunDTO, overwrite: boolean) => {
    if (options.sessionId && run.sessionId !== options.sessionId) return;
    if (overwrite || !byId.has(run.executionId)) byId.set(run.executionId, run);
  };
  current.forEach((run) => add(run, false));
  incoming.forEach((run) => add(run, options.incomingWins === true));
  return [...byId.values()]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.executionId.localeCompare(b.executionId))
    .slice(-20);
}

function statusLabel(run: ExternalRunDTO): string {
  switch (run.status) {
    case 'running': return 'Running…';
    case 'exited': return run.exitCode === null ? 'exited' : `exit ${run.exitCode}`;
    case 'timed_out': return 'timed out';
    case 'cancelled': return 'cancelled';
    case 'failed_to_start': return 'failed';
  }
}

function commandSummary(command: string): string {
  const normalized = command.replace(/\s+/g, ' ').trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}…` : normalized;
}

function outputPreview(output: string): string {
  const lines = output.trimEnd().split('\n');
  return lines.at(-1)?.trim() || '';
}

export function ExternalRunCard({ run }: { run: ExternalRunDTO }) {
  const [open, setOpen] = useState(run.status === 'running');
  const preview = outputPreview(run.output);
  const emptyOutput = run.output.length === 0;
  const failed = run.status === 'timed_out' || run.status === 'failed_to_start' ||
    (run.status === 'exited' && run.exitCode !== null && run.exitCode !== 0);
  return (
    <details
      className="external-run-card"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="external-run-kind">MCP · {run.tool}</span>
        <code className="external-run-command" title={run.command}>{commandSummary(run.command)}</code>
        <span className={`external-run-status${run.status === 'running' ? ' is-running' : ''}${failed ? ' is-failed' : ''}`}>
          {statusLabel(run)}
        </span>
        <span className="external-run-preview" title={preview || undefined}>
          {preview || (run.status === 'running' ? 'No output yet' : 'No output')}
        </span>
      </summary>
      <div className="external-run-body">
        <pre className="external-run-command-full" aria-label="Full command">{run.command}</pre>
        {run.truncated && <p className="external-run-tail-note">Tail only</p>}
        <pre>{emptyOutput ? (run.status === 'running' ? 'No output yet' : 'No output') : run.output}</pre>
      </div>
    </details>
  );
}

export function useExternalRuns(rpc: Rpc, sessionId: string): ExternalRunDTO[] {
  const [state, setState] = useState<{ sessionId: string; runs: ExternalRunDTO[] }>({ sessionId, runs: [] });
  const liveRuns = useRef(new Map<string, ExternalRunDTO>());
  const runs = state.sessionId === sessionId ? state.runs : [];

  useEffect(() => {
    let active = true;
    liveRuns.current = new Map();
    setState({ sessionId, runs: [] });

    const unsubscribe = rpc.on('session.externalRun', (data) => {
      if (!active || data.sessionId !== sessionId || data.run.sessionId !== sessionId) return;
      liveRuns.current.set(data.run.executionId, data.run);
      setState((current) => ({
        sessionId,
        runs: mergeExternalRunUpdates(
          current.sessionId === sessionId ? current.runs : [],
          [data.run],
          { sessionId, incomingWins: true },
        ),
      }));
    });

    void rpc.request('session.externalRuns', { sessionId }).then(({ runs: history }) => {
      if (!active) return;
      setState((current) => {
        const existing = current.sessionId === sessionId ? current.runs : [];
        const merged = mergeExternalRunUpdates(existing, history, { sessionId });
        return {
          sessionId,
          runs: mergeExternalRunUpdates(merged, [...liveRuns.current.values()], {
            sessionId,
            incomingWins: true,
          }),
        };
      });
    }).catch(() => {
      // Live updates remain available when history cannot be loaded.
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [rpc, sessionId]);

  return runs;
}

export function ExternalRunFeed({
  rpc,
  sessionId,
  variant = 'stream',
}: {
  rpc: Rpc;
  sessionId: string;
  variant?: 'stream' | 'terminal';
}) {
  const runs = useExternalRuns(rpc, sessionId);
  const [dockOpen, setDockOpen] = useState(false);
  const hasRunning = runs.some((run) => run.status === 'running');

  useEffect(() => {
    setDockOpen(false);
  }, [rpc, sessionId]);

  useEffect(() => {
    if (hasRunning) setDockOpen(true);
  }, [hasRunning]);

  if (runs.length === 0) return null;
  const cards = runs.map((run) => <ExternalRunCard key={run.executionId} run={run} />);
  if (variant === 'terminal') {
    return (
      <section className={`external-run-dock${dockOpen ? ' is-open' : ''}`} aria-label="MCP activity">
        <button
          className="external-run-dock-toggle"
          type="button"
          aria-expanded={dockOpen}
          disabled={hasRunning}
          onClick={() => setDockOpen((open) => !open)}
        >
          MCP activity ({runs.length})
        </button>
        {dockOpen && <div className="external-run-list">{cards}</div>}
      </section>
    );
  }
  return <section className="external-run-feed" aria-label="MCP activity">{cards}</section>;
}
