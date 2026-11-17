import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Commands external MCP clients run in an approved project (run_command,
 * git_commit, git_push). Waits briefly for a result so quick commands answer in
 * one call; slower ones return an execution id to poll — the relay gives a
 * forwarded call only 15 s. Output is capped, masked on read, and every run is
 * written to the audit log.
 */

const SYNC_WAIT_MS = 10_000;
const MAX_OUTPUT = 256 * 1024;
const PAGE = 32 * 1024;
const KEEP = 50;
const LINKED_OUTPUT = 32 * 1024;
const KEEP_LINKED = 20;
const LINKED_UPDATE_MS = 250;

export interface ExternalExecLink {
  sessionId: string;
  stableSessionId: string;
}

export interface LinkedExternalRun {
  executionId: string;
  sessionId: string;
  tool: string;
  command: string;
  status: Execution['status'];
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  output: string;
  truncated: boolean;
}

type StoredLinkedRun = Omit<LinkedExternalRun, 'sessionId'> & { stableSessionId: string };

type RunRecord = Execution & {
  child?: ChildProcess;
  done: Promise<void>;
  link?: ExternalExecLink;
  linkedOutput?: string;
  linkedOutputTruncated?: boolean;
  linkedTimer?: ReturnType<typeof setTimeout>;
  linkedLastSentAt?: number;
};

const tailUtf8 = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
};

export interface Execution {
  id: string;
  client_id: string;
  root: string;
  tool: string;
  command: string;
  status: 'running' | 'exited' | 'timed_out' | 'cancelled' | 'failed_to_start';
  exit_code: number | null;
  started_at: string;
  ended_at?: string;
  output: string;
  truncated: boolean;
}

export const maskOutput = (text: string): string =>
  text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/(Authorization:\s*\w+\s+)\S+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[\w.+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b(sk-[\w-]{16,}|gh[pousr]_\w{16,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16})\b/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[redacted]');

export class ExternalExec {
  private readonly runs = new Map<string, RunRecord>();
  private readonly linkedRuns = new Map<string, { stableSessionId: string; run: LinkedExternalRun }>();
  private readonly audit: string;
  private readonly linkedHistoryPath: string;
  private readonly onLinkedUpdate?: (run: LinkedExternalRun) => void;
  private linkedHistory: StoredLinkedRun[] = [];

  constructor(home: string, onLinkedUpdate?: (run: LinkedExternalRun) => void) {
    this.audit = join(home, 'external-mcp', 'audit.log');
    this.linkedHistoryPath = join(home, 'external-mcp', 'linked-runs.json');
    this.onLinkedUpdate = onLinkedUpdate;
    try {
      const saved: unknown = JSON.parse(readFileSync(this.linkedHistoryPath, 'utf8'));
      if (Array.isArray(saved)) {
        this.linkedHistory = saved
          .filter((run): run is StoredLinkedRun => this.validStoredRun(run))
          .slice(-KEEP_LINKED);
      }
    } catch {
      // A missing or damaged history file must not prevent MCP execution.
    }
  }

  private validStoredRun(run: unknown): run is StoredLinkedRun {
    if (!run || typeof run !== 'object') return false;
    const r = run as Partial<StoredLinkedRun>;
    return (
      typeof r.executionId === 'string' &&
      typeof r.stableSessionId === 'string' &&
      typeof r.tool === 'string' &&
      typeof r.command === 'string' &&
      ['running', 'exited', 'timed_out', 'cancelled', 'failed_to_start'].includes(r.status ?? '') &&
      (typeof r.exitCode === 'number' || r.exitCode === null) &&
      typeof r.startedAt === 'string' &&
      (typeof r.endedAt === 'string' || r.endedAt === null) &&
      typeof r.output === 'string' &&
      typeof r.truncated === 'boolean'
    );
  }

  private linkedView(e: RunRecord): LinkedExternalRun | undefined {
    if (!e.link) return undefined;
    const masked = maskOutput(e.linkedOutput ?? e.output);
    const bytes = Buffer.byteLength(masked, 'utf8');
    return {
      executionId: e.id,
      sessionId: e.link.sessionId,
      tool: e.tool,
      command: maskOutput(e.command),
      status: e.status,
      exitCode: e.exit_code,
      startedAt: e.started_at,
      endedAt: e.ended_at ?? null,
      output: tailUtf8(masked, LINKED_OUTPUT),
      truncated: e.truncated || !!e.linkedOutputTruncated || bytes > LINKED_OUTPUT,
    };
  }

  private publishLinked(e: RunRecord): void {
    const run = this.linkedView(e);
    if (!run || !e.link) return;
    e.linkedLastSentAt = Date.now();
    this.linkedRuns.set(e.id, { stableSessionId: e.link.stableSessionId, run });
    const excess = Math.max(0, this.linkedRuns.size - KEEP);
    for (const id of [...this.linkedRuns.keys()].slice(0, excess)) {
      if (this.linkedRuns.get(id)?.run.status !== 'running') this.linkedRuns.delete(id);
    }
    try {
      this.onLinkedUpdate?.(run);
    } catch {
      // UI listeners must not affect the external command.
    }
  }

  private queueLinkedUpdate(e: RunRecord): void {
    if (!e.link) return;
    const elapsed = Date.now() - (e.linkedLastSentAt ?? 0);
    if (elapsed >= LINKED_UPDATE_MS) {
      if (e.linkedTimer) clearTimeout(e.linkedTimer);
      e.linkedTimer = undefined;
      e.linkedLastSentAt = Date.now();
      this.publishLinked(e);
      return;
    }
    if (e.linkedTimer) return;
    e.linkedTimer = setTimeout(() => {
      e.linkedTimer = undefined;
      if (e.status === 'running') {
        e.linkedLastSentAt = Date.now();
        this.publishLinked(e);
      }
    }, LINKED_UPDATE_MS - elapsed);
    e.linkedTimer.unref?.();
  }

  private finishLinked(e: RunRecord): void {
    if (e.linkedTimer) clearTimeout(e.linkedTimer);
    e.linkedTimer = undefined;
    e.linkedLastSentAt = Date.now();
    this.publishLinked(e);
  }

  private persistLinked(e: RunRecord): void {
    const run = this.linkedView(e);
    if (!run || !e.link || !run.endedAt) return;
    const { sessionId: _runtimeSessionId, ...persistedRun } = run;
    const stored: StoredLinkedRun = {
      ...persistedRun,
      stableSessionId: e.link.stableSessionId,
    };
    this.linkedHistory = [
      ...this.linkedHistory.filter((item) => item.executionId !== stored.executionId),
      stored,
    ].slice(-KEEP_LINKED);
    const tempPath = `${this.linkedHistoryPath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.linkedHistoryPath), { recursive: true, mode: 0o700 });
      writeFileSync(tempPath, `${JSON.stringify(this.linkedHistory)}\n`, { mode: 0o600 });
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, this.linkedHistoryPath);
    } catch {
      try {
        unlinkSync(tempPath);
      } catch {
        // The temp file may not have been created or may already be renamed.
      }
      // Persisted run history is best-effort and must not affect command completion.
    }
  }

  listLinked(stableSessionId: string, runtimeSessionId: string): LinkedExternalRun[] {
    const matches = new Map<string, StoredLinkedRun>();
    for (const run of this.linkedHistory) {
      if (run.stableSessionId === stableSessionId) matches.set(run.executionId, run);
    }
    for (const [executionId, linked] of this.linkedRuns) {
      if (linked.stableSessionId !== stableSessionId) continue;
      const { sessionId: _oldRuntimeId, ...run } = linked.run;
      matches.set(executionId, { ...run, stableSessionId });
    }
    return [...matches.values()]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, KEEP_LINKED)
      .map(({ stableSessionId: _stableSessionId, ...run }) => ({ ...run, sessionId: runtimeSessionId }));
  }

  private log(e: Execution, event: string): void {
    try {
      appendFileSync(
        this.audit,
        `${JSON.stringify({
          at: new Date().toISOString(),
          event,
          execution_id: e.id,
          client: e.client_id,
          project: e.root,
          tool: e.tool,
          command: maskOutput(e.command),
          status: e.status,
          exit_code: e.exit_code,
        })}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* the audit log must never break the call */
    }
  }

  /** Start `argv` (or a shell command line when `argv` has one element and shell=true). */
  async start(opts: {
    clientId: string;
    root: string;
    tool: string;
    argv: string[];
    shell?: boolean;
    timeoutMs: number;
    link?: ExternalExecLink;
    /** Safe user-facing/audit label when argv contains a fixed internal command. */
    displayCommand?: string;
    env?: NodeJS.ProcessEnv;
  }) {
    const id = randomUUID();
    const commandLine = opts.shell ? (opts.argv[0] ?? '') : opts.argv.join(' ');
    const command = opts.displayCommand ?? commandLine;
    const e: Execution = {
      id,
      client_id: opts.clientId,
      root: opts.root,
      tool: opts.tool,
      command,
      status: 'running',
      exit_code: null,
      started_at: new Date().toISOString(),
      output: '',
      truncated: false,
    };
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => {
      finish = r;
    });
    const rec: RunRecord = Object.assign(e, { done, ...(opts.link ? { link: opts.link } : {}) });
    this.runs.set(id, rec);
    for (const old of [...this.runs.keys()].slice(0, Math.max(0, this.runs.size - KEEP)))
      if (this.runs.get(old)?.status !== 'running') this.runs.delete(old);
    this.publishLinked(rec);
    const env = {
      ...process.env,
      ...opts.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      CI: process.env.CI ?? '1',
    };
    const [file, args] = opts.shell
      ? [process.env.SHELL || '/bin/zsh', ['-lc', commandLine]]
      : [opts.argv[0] as string, opts.argv.slice(1)];
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: opts.root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      rec.status = 'failed_to_start';
      rec.output = String(err);
      rec.ended_at = new Date().toISOString();
      finish();
      this.log(rec, 'end');
      this.finishLinked(rec);
      this.persistLinked(rec);
      return this.view(rec);
    }
    rec.child = child;
    this.log(rec, 'start');
    const add = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (rec.link) {
        const combined = (rec.linkedOutput ?? '') + text;
        if (combined.length > MAX_OUTPUT) {
          rec.linkedOutput = combined.slice(-MAX_OUTPUT);
          rec.linkedOutputTruncated = true;
        } else {
          rec.linkedOutput = combined;
        }
      }
      if (rec.output.length >= MAX_OUTPUT) {
        rec.truncated = true;
        if (rec.link) this.queueLinkedUpdate(rec);
        return;
      }
      rec.output += text;
      if (rec.output.length > MAX_OUTPUT) {
        rec.output = rec.output.slice(0, MAX_OUTPUT);
        rec.truncated = true;
      }
      this.queueLinkedUpdate(rec);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    const timer = setTimeout(() => {
      if (rec.status === 'running') rec.status = 'timed_out';
      this.finishLinked(rec);
      killGroup();
    }, opts.timeoutMs);
    timer.unref?.();
    child.on('error', (err) => {
      rec.status = 'failed_to_start';
      rec.output += String(err);
      this.finishLinked(rec);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (rec.status === 'running') rec.status = 'exited';
      rec.exit_code = code;
      rec.ended_at = new Date().toISOString();
      rec.child = undefined;
      this.finishLinked(rec);
      this.persistLinked(rec);
      finish();
      this.log(rec, 'end');
    });
    await Promise.race([done, new Promise((r) => setTimeout(r, SYNC_WAIT_MS).unref?.())]);
    return this.view(rec);
  }

  /** The client's own execution, paged from `cursor` (bytes of output). */
  get(clientId: string, id: string, cursor = 0) {
    const e = this.runs.get(id);
    if (!e || e.client_id !== clientId) throw new Error('execution_not_found');
    return this.view(e, cursor);
  }

  cancel(clientId: string, id: string) {
    const e = this.runs.get(id);
    if (!e || e.client_id !== clientId) throw new Error('execution_not_found');
    if (e.status === 'running' && e.child?.pid) {
      e.status = 'cancelled';
      this.finishLinked(e);
      try {
        process.kill(-e.child.pid, 'SIGTERM');
      } catch {
        e.child.kill('SIGTERM');
      }
    }
    return this.view(e);
  }

  /** Wait for completion (tests, and git steps that chain). */
  async wait(id: string): Promise<void> {
    await this.runs.get(id)?.done;
  }

  private view(e: Execution, cursor = 0) {
    const start = Math.max(0, Math.min(cursor, e.output.length));
    const slice = e.output.slice(start, start + PAGE);
    const next = start + slice.length;
    return {
      execution_id: e.id,
      tool: e.tool,
      command: maskOutput(e.command),
      status: e.status,
      exit_code: e.exit_code,
      started_at: e.started_at,
      ended_at: e.ended_at ?? null,
      output: maskOutput(slice),
      output_cursor: start,
      next_cursor: next < e.output.length || e.status === 'running' ? next : null,
      output_truncated: e.truncated,
    };
  }
}
