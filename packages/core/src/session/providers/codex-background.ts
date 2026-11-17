import { constants, closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { BgShellDTO } from '@ateam/contract';
import { observeProgress } from '../bg-eta';
import { commandLabel, type fileSizes, progressOf } from '../bg-progress';
import type { readBackgroundShell } from '../bg-shells';
import {
  type ExecCall,
  codexExecBatch,
  codexExecBatchResults,
  codexExecCall,
  codexExecResult,
} from './codex-exec-call';
import { codexRolloutPath } from './codex-sessions';
import { listCodexSubagents } from './codex-subagents';
import { commandText } from './codex-transcript';

type Job = {
  processId: string;
  command: string;
  cwd: string;
  startedAtMs: number;
  lastAt: string;
  output: string;
  done: boolean;
  exitCode?: number;
  log?: { text: string; bytes: number; mtime: number; path: string };
};
type State = {
  identity: string;
  mtime: number;
  offset: number;
  skip: boolean;
  threadId?: string;
  cwd: string;
  parent?: string;
  calls: Map<string, { calls: (ExecCall | undefined)[]; batch: boolean; at: string }>;
  jobs: Map<string, Job>;
  completions: Map<string, { at: string; item: Record<string, unknown> }>;
};
const states = new Map<string, State>();
const observedSinceMs = Date.now();
const CHUNK = 8 * 1024 * 1024;
const TAIL = 64 * 1024;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function scan(threadId: string): State | undefined {
  const path = codexRolloutPath(threadId);
  if (!path) return undefined;
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    const identity = `${stat.dev}:${stat.ino}`;
    let state = states.get(path);
    if (
      !state ||
      state.identity !== identity ||
      stat.size < state.offset ||
      (stat.size === state.offset && stat.mtimeMs !== state.mtime)
    )
      state = {
        identity,
        mtime: stat.mtimeMs,
        offset: 0,
        skip: false,
        cwd: '',
        calls: new Map(),
        jobs: new Map(),
        completions: new Map(),
      };
    states.delete(path);
    states.set(path, state);
    state.mtime = stat.mtimeMs;
    if (states.size > 64) states.delete(states.keys().next().value as string);
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(Math.min(CHUNK, stat.size - state.offset));
    const read = readSync(fd, buffer, 0, buffer.length, state.offset);
    const end = buffer.subarray(0, read).lastIndexOf(10) + 1;
    if (!end) {
      if (read === CHUNK) {
        state.offset += read;
        state.skip = true;
      }
      return state.threadId === threadId ? state : undefined;
    }
    const start = state.skip ? buffer.indexOf(10) + 1 : 0;
    state.skip = false;
    for (const line of buffer.toString('utf8', start, end).split('\n')) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = object(record.payload);
      const at = str(record.timestamp);
      if (record.type === 'session_meta') {
        state.threadId = str(payload.id);
        state.cwd = str(payload.cwd);
        state.parent = str(
          object(object(object(payload.source).subagent).thread_spawn).parent_thread_id,
        );
      }
      if (record.type === 'response_item') {
        const id = str(payload.call_id);
        const call = codexExecCall(payload);
        const batch = call ? undefined : codexExecBatch(payload);
        if ((call || batch) && id) {
          state.calls.set(id, { calls: batch ?? [call], batch: !!batch, at });
          if (state.calls.size > 2000)
            state.calls.delete(state.calls.keys().next().value as string);
        } else if (
          ['custom_tool_call_output', 'function_call_output'].includes(str(payload.type))
        ) {
          const pending = state.calls.get(id);
          if (!pending) continue;
          state.calls.delete(id);
          const results = pending.batch
            ? codexExecBatchResults(payload.output, pending.calls.length)
            : [codexExecResult(payload.output)];
          if (!results) continue;
          for (const [index, pendingCall] of pending.calls.entries()) {
            const result = results[index];
            if (!result || !pendingCall) continue;
            if (
              pendingCall.kind === 'exec_command' &&
              result.processId &&
              result.exitCode === undefined
            ) {
              const cwd = pendingCall.cwd ? resolve(state.cwd, pendingCall.cwd) : state.cwd;
              const startedAtMs = Date.parse(pending.at);
              if (!isAbsolute(cwd) || !Number.isFinite(startedAtMs)) continue;
              state.jobs.set(result.processId, {
                processId: result.processId,
                command: pendingCall.cmd,
                cwd,
                startedAtMs,
                lastAt: at,
                output: result.output.slice(-TAIL),
                done: false,
              });
              const completion = state.completions.get(result.processId);
              const created = state.jobs.get(result.processId);
              if (completion && created && Date.parse(completion.at) >= startedAtMs)
                complete(created, completion.item, completion.at);
              if (state.jobs.size > 200)
                state.jobs.delete(state.jobs.keys().next().value as string);
            } else if (pendingCall.kind === 'write_stdin') {
              const job = state.jobs.get(pendingCall.processId);
              if (!job || job.done || (result.processId && result.processId !== job.processId))
                continue;
              job.output = (job.output + result.output).slice(-TAIL);
              job.lastAt = at;
              if (result.exitCode !== undefined) {
                job.done = true;
                job.exitCode = result.exitCode;
              }
            }
          }
        }
      }
      if (record.type === 'event_msg' && payload.type === 'item_completed') {
        const item = object(payload.item);
        if (item.type !== 'CommandExecution') continue;
        const rawPid =
          typeof item.process_id === 'number'
            ? String(item.process_id)
            : typeof item.process_id === 'string'
              ? item.process_id
              : typeof item.id === 'string' && /^\d+$/.test(item.id)
                ? item.id
                : undefined;
        const processId = rawPid && /^\d+$/.test(rawPid) ? rawPid : undefined;
        const status = str(item.status);
        const hasExit = typeof item.exit_code === 'number';
        if (!hasExit && status && !['completed', 'failed', 'declined', 'success'].includes(status))
          continue;
        const itemRecord: Record<string, unknown> = {
          exit_code: hasExit ? item.exit_code : 0,
          aggregated_output: (
            str(item.aggregated_output) ||
            [str(item.stdout), str(item.stderr)].filter(Boolean).join('\n')
          ).slice(-TAIL),
        };
        let matched = false;
        if (processId) {
          state.completions.set(processId, { at, item: itemRecord });
          if (state.completions.size > 200)
            state.completions.delete(state.completions.keys().next().value as string);
          const job = state.jobs.get(processId);
          if (job && Date.parse(at) >= job.startedAtMs) {
            complete(job, itemRecord, at);
            matched = true;
          }
        }
        if (!matched) {
          const cmd = commandText(item.command);
          if (cmd) {
            for (const job of state.jobs.values()) {
              if (
                !job.done &&
                (job.command === cmd || commandLabel(job.command) === commandLabel(cmd))
              ) {
                if (Date.parse(at) >= job.startedAtMs) {
                  complete(job, itemRecord, at);
                  break;
                }
              }
            }
          }
        }
      }
    }
    state.offset += end;
    return state.threadId === threadId ? state : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function refreshLog(job: Job): void {
  if (job.done) return;
  const path = codexLogPath(job.command);
  if (!path) return;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.mtimeMs < job.startedAtMs) return;
    const buffer = Buffer.alloc(Math.min(TAIL, stat.size));
    const read = readSync(fd, buffer, 0, buffer.length, stat.size - buffer.length);
    job.log = {
      text: buffer.toString('utf8', 0, read),
      bytes: stat.size,
      mtime: stat.mtimeMs,
      path,
    };
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function complete(job: Job, item: Record<string, unknown>, at: string): void {
  job.done = true;
  job.lastAt = at;
  if (typeof item.exit_code === 'number') job.exitCode = item.exit_code;
  const output =
    str(item.aggregated_output) || [str(item.stdout), str(item.stderr)].filter(Boolean).join('\n');
  if (output) job.output = output.slice(-TAIL);
}

export function codexLogPath(command: string): string | undefined {
  if (/<<|\$\(|`|\[\[|\(\(/.test(command)) return undefined;
  let quote = '';
  let escaped = false;
  const targets: (string | undefined)[] = [];
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>' && command[index - 1] !== '>') {
      const descriptor = /(?:^|[\s;&|])(\d+)$/.exec(command.slice(0, index))?.[1];
      if (descriptor && descriptor !== '1') continue;
      const remaining = command.slice(index + 1);
      const match = /^>?\s*("[^"\n]*"|'[^'\n]*'|[^\s;&|<>]+)/.exec(remaining);
      const target = match?.[1]?.replace(/^["']|["']$/g, '');
      const suffix = match ? remaining.slice(match[0].length).trim() : '';
      targets.push(
        target &&
          isAbsolute(target) &&
          !target.includes('$') &&
          !target.includes('\\') &&
          target !== '/dev/null' &&
          /^(?:2>&1\s*)?&?$/.test(suffix)
          ? target
          : undefined,
      );
    }
  }
  return targets.length === 1 ? targets[0] : undefined;
}

function jobsFor(parentId: string): {
  id: string;
  agentId?: string;
  job: Job;
  isSubagentDone?: boolean;
}[] {
  const result: { id: string; agentId?: string; job: Job; isSubagentDone?: boolean }[] = [];
  const subagents = listCodexSubagents(parentId);
  const doneAgentIds = new Set(subagents.filter((a) => a.done).map((a) => a.agentId));
  const ids = [parentId, ...subagents.map((agent) => agent.agentId)];
  for (const threadId of ids) {
    const state = scan(threadId);
    if (!state || (threadId !== parentId && state.parent !== parentId)) continue;
    const isSubagentDone = threadId !== parentId && doneAgentIds.has(threadId);
    for (const job of state.jobs.values()) {
      refreshLog(job);
      result.push({
        id: `codex-${threadId}-${job.processId}`,
        ...(threadId !== parentId ? { agentId: threadId } : {}),
        job,
        isSubagentDone,
      });
    }
  }
  return result;
}

export function listCodexBackground(parentId: string): BgShellDTO[] {
  const now = Date.now();
  return jobsFor(parentId).map(({ id, agentId, job, isSubagentDone }) => {
    const lastActivityMs = Math.max(Date.parse(job.lastAt) || 0, job.log?.mtime ?? 0);
    const silentMs = now - lastActivityMs;
    const statusUnknown = Boolean(
      !job.done &&
        (lastActivityMs < observedSinceMs ||
          (isSubagentDone && silentMs > 30_000) ||
          (!job.log && silentMs > 300_000) ||
          (Boolean(job.log) && silentMs > 600_000)),
    );
    const output = job.log?.text ?? job.output;
    const parsed = progressOf(output);
    const progress = parsed.progress;
    const timing = progress
      ? observeProgress(id, progress, Date.now(), {
          startedAtMs: job.startedAtMs,
          changedAtMs: job.log?.mtime ?? Date.parse(job.lastAt),
        })
      : {};
    return {
      id,
      agentId,
      done: job.done,
      statusUnknown,
      exitCode: job.exitCode,
      bytes: job.log?.bytes ?? Buffer.byteLength(job.output),
      lastAt: job.log ? new Date(job.log.mtime).toISOString() : job.lastAt,
      head: output.split(/\r?\n/)[0] ?? '',
      startedAtMs: job.startedAtMs,
      label: commandLabel(job.command),
      lastLine: parsed.lastLine,
      ...(!job.done && !statusUnknown && progress ? { progress: { ...timing, ...progress } } : {}),
    };
  });
}

export function readCodexBackground(
  parentId: string,
  id: string,
  tailBytes = TAIL,
): ReturnType<typeof readBackgroundShell> & {
  command?: string;
  label?: string;
  files?: ReturnType<typeof fileSizes>;
} {
  const found = jobsFor(parentId).find((entry) => entry.id === id);
  if (!found) return { text: '', bytes: 0, truncated: false, done: true };
  const { job, isSubagentDone } = found;
  const now = Date.now();
  const lastActivityMs = Math.max(Date.parse(job.lastAt) || 0, job.log?.mtime ?? 0);
  const silentMs = now - lastActivityMs;
  const effectivelyDone =
    job.done || (isSubagentDone && silentMs > 30_000) || (!job.log && silentMs > 300_000);
  const limit = Number.isFinite(tailBytes) ? Math.max(1024, Math.min(TAIL, tailBytes)) : TAIL;
  const text = Buffer.from(job.log?.text ?? job.output)
    .subarray(-limit)
    .toString('utf8');
  const bytes = job.log?.bytes ?? Buffer.byteLength(job.output);
  return {
    text,
    bytes,
    truncated: Buffer.byteLength(text) < bytes,
    done: effectivelyDone,
    exitCode: job.exitCode,
    command: job.command,
    label: commandLabel(job.command),
    ...(job.log ? { logPath: job.log.path } : {}),
  };
}
