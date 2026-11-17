import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Turn } from '@ateam/contract';
import type { SubagentInfo } from '../subagents';
import { readChunk } from '../transcript-file';
import { codexRolloutPath } from './codex-sessions';
import {
  type CodexProjectionOptions,
  codexResponseCallIds,
  codexResponseOutputIds,
  codexToolSource,
  parseCodexBlocks,
} from './codex-transcript';

type RecordData = { timestamp?: string; type?: string; payload?: Record<string, unknown> };
type AgentStatus = 'running' | 'idle' | 'closed' | 'errored' | 'unknown';
type Agent = { task: string; label?: string; at: string; status?: AgentStatus; statusAt?: string };
type Scan = {
  offset: number;
  identity: string;
  mtime: number;
  size: number;
  skipLine?: boolean;
  agents: Map<string, Agent>;
  threadId?: string;
  parent?: string;
  startedAt: string;
  lastAt: string;
  status?: AgentStatus;
  statusAt?: string;
  activity?: string;
  toolSource?: CodexProjectionOptions['toolSource'];
  responseCallIds: Set<string>;
  responseOutputIds: Set<string>;
};

const scans = new Map<string, Scan>();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const WINDOW = 8 * 1024 * 1024;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function agentStatus(value: unknown): AgentStatus | undefined {
  const state = typeof value === 'string' ? value : Object.keys(object(value))[0];
  if (state === 'pending_init' || state === 'running') return 'running';
  if (state === 'completed') return 'idle';
  if (state === 'shutdown') return 'closed';
  if (state === 'errored') return 'errored';
  return undefined;
}

function spawnedAgents(output: unknown): { id: string; label: string }[] {
  const agents: { id: string; label: string }[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      if (value.length > 65536) return;
      try {
        visit(JSON.parse(value), depth + 1);
      } catch {}
      return;
    }
    if (Array.isArray(value)) {
      for (const part of value.slice(0, 100)) visit(part, depth + 1);
      return;
    }
    const record = object(value);
    const id = text(record.agent_id);
    if (UUID.test(id)) agents.push({ id, label: text(record.nickname).slice(0, 80) });
    if (record.type === 'input_text' || record.type === 'text') visit(record.text, depth + 1);
    if (record.content) visit(record.content, depth + 1);
  };
  visit(output, 0);
  return agents;
}

function scanRollout(path: string): Scan | undefined {
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    const identity = `${stat.dev}:${stat.ino}`;
    let scan = scans.get(path);
    if (
      !scan ||
      scan.identity !== identity ||
      stat.size < scan.offset ||
      (stat.size === scan.offset && stat.mtimeMs !== scan.mtime)
    ) {
      scan = {
        offset: 0,
        identity,
        mtime: stat.mtimeMs,
        size: stat.size,
        agents: new Map(),
        startedAt: '',
        lastAt: '',
        responseCallIds: new Set(),
        responseOutputIds: new Set(),
      };
    }
    scans.delete(path);
    scans.set(path, scan);
    if (scans.size > 64) scans.delete(scans.keys().next().value as string);
    if (scan.offset === stat.size) return scan;
    scan.size = stat.size;
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(Math.min(WINDOW, stat.size - scan.offset));
    const count = readSync(fd, buffer, 0, buffer.length, scan.offset);
    const cut = buffer.subarray(0, count).lastIndexOf(10) + 1;
    if (!cut) {
      if (count === WINDOW) {
        scan.offset += count;
        scan.skipLine = true;
      }
      return scan;
    }
    const start = scan.skipLine ? buffer.subarray(0, cut).indexOf(10) + 1 : 0;
    scan.skipLine = false;
    const lines = buffer.subarray(start, cut).toString('utf8').split('\n');
    scan.toolSource ??= codexToolSource(lines);
    if (codexToolSource(lines) === 'response_item') scan.toolSource = 'response_item';
    collectResponseCallIds(scan.responseCallIds, lines);
    collectResponseOutputIds(scan.responseOutputIds, lines);
    for (const line of lines) {
      let record: RecordData;
      try {
        record = JSON.parse(line) as RecordData;
      } catch {
        continue;
      }
      const payload = record.payload ?? {};
      const at = text(record.timestamp);
      if (at) scan.lastAt = at;
      if (record.type === 'session_meta') {
        scan.threadId = text(payload.id);
        scan.startedAt = text(payload.timestamp) || at;
        const spawn = object(object(object(payload.source).subagent).thread_spawn);
        scan.parent = text(spawn.parent_thread_id);
      }
      if (
        record.type === 'response_item' &&
        (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output')
      ) {
        for (const agent of spawnedAgents(payload.output)) {
          const previous = scan.agents.get(agent.id);
          if (!previous)
            scan.agents.set(agent.id, { task: '', label: agent.label || undefined, at });
          else if (!previous.label && agent.label) previous.label = agent.label;
        }
      }
      for (const turn of parseCodexBlocks(line, '', 0, {
        toolSource: scan.toolSource,
        responseCallIds: scan.responseCallIds,
        responseOutputIds: scan.responseOutputIds,
      })) {
        if (turn.role === 'assistant' && (turn.kind === 'tool_use' || turn.kind === 'text'))
          scan.activity =
            `${turn.toolName ? `${turn.toolName} · ` : ''}${turn.text.split('\n', 1)[0]}`.slice(
              0,
              140,
            );
      }
      if (record.type !== 'event_msg') continue;
      if (payload.type === 'task_started' || payload.type === 'turn_started') {
        scan.status = 'running';
        scan.statusAt = at;
      }
      if (payload.type === 'task_complete' || payload.type === 'turn_complete') {
        scan.status = payload.error ? 'errored' : 'idle';
        scan.statusAt = at;
      }
      if (payload.type === 'turn_aborted') {
        scan.status = 'idle';
        scan.statusAt = at;
      }
      const item =
        payload.type === 'sub_agent_activity'
          ? { ...payload, type: 'SubAgentActivity' }
          : object(payload.item);
      if (payload.type === 'item_completed' && item.type === 'CollabAgentToolCall') {
        const ids = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : [];
        const receivers = Array.isArray(item.receiver_agents) ? item.receiver_agents : [];
        for (const id of ids) {
          if (typeof id !== 'string' || !UUID.test(id)) continue;
          const previous = scan.agents.get(id);
          const receiver = receivers.map(object).find((entry) => entry.thread_id === id);
          const status =
            item.tool === 'close_agent' && item.status === 'completed'
              ? 'closed'
              : agentStatus(object(item.agents_states)[id]);
          scan.agents.set(id, {
            task: previous?.task || text(item.prompt).replace(/\s+/g, ' ').slice(0, 120),
            label: text(receiver?.agent_nickname) || previous?.label,
            at: previous?.at || at,
            status: status || previous?.status,
            statusAt: status ? at : previous?.statusAt,
          });
        }
      }
      if (item.type === 'SubAgentActivity') {
        const id = text(item.agent_thread_id);
        if (UUID.test(id) && !scan.agents.has(id)) scan.agents.set(id, { task: '', at });
        const agent = scan.agents.get(id);
        const status =
          item.kind === 'started'
            ? 'running'
            : item.kind === 'completed' || item.kind === 'interrupted'
              ? 'idle'
              : undefined;
        if (agent && status && agent.status !== 'closed') {
          agent.status = status;
          agent.statusAt = at;
        }
      }
    }
    scan.offset += cut;
    scan.mtime = stat.mtimeMs;
    return scan;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function childRollout(parentId: string, agentId: string): { path: string; scan: Scan } | undefined {
  if (!UUID.test(agentId) || !UUID.test(parentId)) return undefined;
  const path = codexRolloutPath(agentId);
  const scan = scanRollout(path);
  return scan?.threadId === agentId && scan.parent === parentId ? { path, scan } : undefined;
}

export function listCodexSubagents(parentId: string): (SubagentInfo & { status: AgentStatus })[] {
  if (!UUID.test(parentId)) return [];
  const parent = scanRollout(codexRolloutPath(parentId));
  if (!parent || parent.threadId !== parentId) return [];
  const agents: (SubagentInfo & { status: AgentStatus })[] = [];
  for (const [agentId, agent] of parent.agents) {
    const child = childRollout(parentId, agentId)?.scan;
    if (!child) continue;
    const caughtUp = child && child.offset === child.size;
    const parentNewer = agent.statusAt && (!child?.statusAt || agent.statusAt > child.statusAt);
    const status =
      agent.status === 'closed' || parentNewer
        ? (agent.status ?? 'unknown')
        : caughtUp && child.statusAt
          ? (child.status ?? 'unknown')
          : (agent.status ?? 'unknown');
    agents.push({
      agentId,
      task: agent.task,
      label: agent.label,
      startedAt: child?.startedAt || agent.at,
      lastAt: child?.lastAt || agent.at,
      turns: 0,
      status,
      done: status === 'idle' || status === 'closed' || status === 'errored',
      activity: child?.activity,
    });
  }
  return agents.sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) || left.agentId.localeCompare(right.agentId),
  );
}

export function readCodexSubagentTranscript(parentId: string, agentId: string): Turn[] {
  const child = childRollout(parentId, agentId);
  if (!child) return [];
  const turns: Turn[] = [];
  const lines = readChunk(child.path, WINDOW, true);
  const toolSource =
    child.scan.toolSource === 'response_item' ? 'response_item' : codexToolSource(lines);
  collectResponseCallIds(child.scan.responseCallIds, lines);
  collectResponseOutputIds(child.scan.responseOutputIds, lines);
  for (const line of lines)
    turns.push(
      ...parseCodexBlocks(line, agentId, turns.length, {
        toolSource,
        responseCallIds: child.scan.responseCallIds,
        responseOutputIds: child.scan.responseOutputIds,
      }),
    );
  return turns;
}

function collectResponseCallIds(ids: Set<string>, lines: readonly string[]): void {
  for (const id of codexResponseCallIds(lines)) {
    ids.delete(id);
    ids.add(id);
    if (ids.size > 20000) ids.delete(ids.values().next().value as string);
  }
}

function collectResponseOutputIds(ids: Set<string>, lines: readonly string[]): void {
  for (const id of codexResponseOutputIds(lines)) {
    ids.delete(id);
    ids.add(id);
    if (ids.size > 20000) ids.delete(ids.values().next().value as string);
  }
}
