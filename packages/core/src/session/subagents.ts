import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Turn } from '@ateam/contract';
import { isTaskId, sessionTasksDir } from './tasks-dir';
import { parseTranscriptBlocks } from './transcript-file';

/**
 * Sub-agents launched by a session, and their conversations.
 *
 * A sub-agent's work does NOT reach the parent's transcript — every record
 * there carries `isSidechain:false`, and the parent only ever shows the one
 * `tool_use(Agent)` that started it plus whatever it reported back at the end.
 * The conversation itself is written to its own file under the harness's task
 * directory, and that file turns out to be a transcript jsonl in exactly the
 * shape parseTranscriptBlocks already reads — same records, same block kinds,
 * only with `isSidechain:true` and an `agentId` on every line. So the whole of
 * a sub-agent's thinking, tools and answers can be rendered with the parser
 * the stream view already uses; nothing here re-implements it.
 *
 * The directory is derivable, not discoverable: /tmp/claude-<uid>/<project
 * slug>/<parent claude session id>/tasks, where the slug is the same
 * non-alphanumeric-to-dash rule that names ~/.claude/projects. Verified
 * against a live run before this was written.
 */

export interface SubagentInfo {
  agentId: string;
  /** the opening instruction — the closest thing a sub-agent has to a title */
  task: string;
  /** ISO; first record's timestamp, else the file's birth */
  startedAt: string;
  /** ISO of the last write — a proxy for "still working" */
  lastAt: string;
  turns: number;
  /** its conversation ended on the agent's own final answer. A SendMessage
   *  to it appends more, and it reads as running again. */
  done: boolean;
  /** the Agent call's short name ("Capture English Trix screenshots") */
  label?: string;
  /** what it is doing now: its latest tool call or words */
  activity?: string;
  /** size of its conversation at its latest reply: input + cache + output
   *  tokens of the last non-empty usage block — the figure claude's own
   *  agent line shows */
  tokens?: number;
}

/** First line of a task file, parsed — cheap enough to do for every file in
 *  the directory, and it is what tells a sub-agent apart from a backgrounded
 *  shell command (those write plain text and share the same folder). Never
 *  read these files whole just to classify them: a busy agent's log runs to
 *  hundreds of KB.
 *
 *  The line is read in chunks rather than in one fixed buffer because the
 *  opening record carries the agent's whole instruction — routinely tens of
 *  KB. A buffer that stops short leaves invalid JSON, which parses as "not a
 *  sub-agent", and the agent silently never appears. */
const FIRST_LINE_CAP = 1 << 20;

function readFirstRecord(path: string): Record<string, unknown> | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const chunk = Buffer.alloc(64 * 1024);
    let acc = Buffer.alloc(0);
    while (acc.length < FIRST_LINE_CAP) {
      const n = readSync(fd, chunk, 0, chunk.length, acc.length);
      if (n <= 0) break;
      acc = Buffer.concat([acc, chunk.subarray(0, n)]);
      const nl = acc.indexOf(0x0a);
      if (nl >= 0) {
        acc = acc.subarray(0, nl);
        break;
      }
    }
    const rec: unknown = JSON.parse(acc.toString('utf8'));
    return rec && typeof rec === 'object' ? (rec as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // plain text (a backgrounded shell), truncated, or gone
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

const openingText = (rec: Record<string, unknown>): string => {
  const msg = rec.message as { content?: unknown } | undefined;
  const c = msg?.content;
  const text = typeof c === 'string' ? c : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
};

/** what the harness leaves behind when an agent is stopped mid-flight */
const INTERRUPTED_RE = /^\s*\[Request interrupted/;
/** a log whose last word is someone talking TO the agent, quiet this long:
 *  the model never answered, so nothing is running any more (its session
 *  died). An agent legitimately waiting on a slow tool ends on its own
 *  tool_use instead, which this leaves alone. */
const STALE_INBOX_MS = 15 * 60 * 1000;
const TAIL_BYTES = 64 * 1024;
const TAIL_CAP = 8 * 1024 * 1024;

/** Whether the agent has given its final answer, and what it did last — from
 *  the end of its log, which runs to megabytes for a busy agent. */
export function tailState(path: string): { done: boolean; activity?: string; tokens?: number } {
  // A tool result carrying a screenshot is a single ~1MB line, so a fixed tail
  // can hold nothing whole: widen until both answers are found (or give up).
  let fd: number | undefined;
  try {
    const st = statSync(path);
    const size = st.size;
    const quiet = Date.now() - st.mtimeMs;
    fd = openSync(path, 'r');
    for (let want = TAIL_BYTES; ; want *= 4) {
      const take = Math.min(want, size, TAIL_CAP);
      const buf = Buffer.alloc(take);
      readSync(fd, buf, 0, take, size - take);
      const found = readTail(buf.toString('utf8'), quiet);
      if ((found.done !== undefined && found.activity) || take >= size || take >= TAIL_CAP)
        return {
          done: found.done ?? false,
          ...(found.activity ? { activity: found.activity } : {}),
          ...(found.tokens ? { tokens: found.tokens } : {}),
        };
    }
  } catch {
    return { done: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readTail(
  text: string,
  quietMs = 0,
): { done?: boolean; activity?: string; tokens?: number } {
  let done: boolean | undefined;
  let activity: string | undefined;
  let tokens: number | undefined;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && (done === undefined || !activity || !tokens); i--) {
    let o: {
      type?: string;
      message?: { content?: unknown; usage?: Record<string, unknown>; stop_reason?: string | null };
    };
    try {
      o = JSON.parse(lines[i] as string);
    } catch {
      continue; // the cut first line, or the one being written
    }
    if (o.type !== 'assistant' && o.type !== 'user') continue; // attachments, system
    const blocks = Array.isArray(o.message?.content)
      ? (o.message?.content as Record<string, unknown>[])
      : [];
    if (done === undefined)
      done =
        // its own final answer: an assistant record that asks for NO tool is
        // the agent having said its last word — nothing follows it but the
        // hand-back. `stop_reason` used to say `end_turn` here and was read
        // as the proof; the CLI leaves it null on a quarter of the agents
        // (53 of 221 logs on this machine, all v2.1.278), and every one of
        // those sat in the panel as if it were still working, its clock
        // running past a day (09-22). A running agent's log ends either on
        // the tool_use it is waiting for or on a result it has not answered.
        (o.type === 'assistant' && saidLastWord(blocks, o.message?.stop_reason, quietMs)) ||
        // …or it was stopped: the harness writes "[Request interrupted by
        // user]" as the agent's last record, and without this ten stopped
        // agents sat in the panel as if they were still working (09-21)
        (o.type === 'user' && blocks.some((b) => INTERRUPTED_RE.test(String(b.text ?? '')))) ||
        // …or the last thing in its log is something said TO it, long ago
        (o.type === 'user' && quietMs > STALE_INBOX_MS);
    if (o.type === 'assistant' && !tokens) {
      // interrupts / API errors carry an all-zero usage block — walk past it
      const u = o.message?.usage ?? {};
      const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
      const sum =
        n('input_tokens') +
        n('cache_creation_input_tokens') +
        n('cache_read_input_tokens') +
        n('output_tokens');
      if (sum > 0) tokens = sum;
    }
    if (o.type !== 'assistant' || activity) continue;
    for (let j = blocks.length - 1; j >= 0 && !activity; j--) {
      const b = blocks[j] as Record<string, unknown>;
      if (b.type === 'tool_use') {
        const input = (b.input ?? {}) as Record<string, unknown>;
        const what = [
          input.description,
          input.command,
          input.file_path,
          input.pattern,
          input.url,
        ].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
        activity = `${String(b.name ?? 'tool')}${what ? ` · ${firstLineOf(what)}` : ''}`;
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        activity = firstLineOf(b.text);
      }
    }
  }
  return { done, activity, tokens };
}

/** a text-only reply with no stop_reason, quiet this long: a final answer
 *  from a CLI that leaves stop_reason null (2.1.278 did on a quarter) */
const NULL_STOP_QUIET_MS = 3 * 60 * 1000;

/**
 * Whether an assistant record, the newest in the log, is the agent's last
 * word. The CLI writes one reply as several records, block by block —
 * thinking, then text, then the tool_use — so "asks for no tool" alone is
 * true for a moment in the middle of nearly every step. Read that way, a
 * working agent vanished from the panel while it thought or wrote and came
 * back with its next tool call (09-28). Measured over 108 agent logs:
 * 4,250 text/thinking records had more after them (4,183 with the same
 * message id); of 94 real endings, every one was text, 93 with
 * stop_reason end_turn, 1 null. Thinking alone never ended a log.
 */
function saidLastWord(
  blocks: Record<string, unknown>[],
  stopReason: string | null | undefined,
  quietMs: number,
): boolean {
  if (blocks.some((b) => b.type === 'tool_use')) return false;
  // thinking: more to come (at most 193s later in those logs) — unless the
  // agent died mid-thought and the log has been still for a long time
  if (!blocks.some((b) => b.type === 'text')) return quietMs > STALE_INBOX_MS;
  if (stopReason === 'end_turn') return true;
  if (stopReason) return false; // 'tool_use': the call is being written
  return quietMs > NULL_STOP_QUIET_MS;
}

const firstLineOf = (s: string): string => (s.trim().split('\n', 1)[0] ?? '').slice(0, 140);

/** The Agent call's `description`. The task file is a link to
 *  `subagents/agent-<id>.jsonl` beside the parent transcript, and next to that
 *  sits `agent-<id>.meta.json` holding it. */
function agentLabel(path: string, agentId: string): string | undefined {
  try {
    const real = realpathSync(path);
    if (basename(real) !== `agent-${agentId}.jsonl`) return undefined;
    const meta = JSON.parse(
      readFileSync(join(dirname(real), `agent-${agentId}.meta.json`), 'utf8'),
    );
    return typeof meta?.description === 'string' && meta.description.trim()
      ? meta.description.trim().slice(0, 120)
      : undefined;
  } catch {
    return undefined; // an older layout keeps no meta file
  }
}

/** Every sub-agent this session has launched, creation order first. */
export function listSubagents(cwd: string, claudeSessionId: string): SubagentInfo[] {
  const dir = sessionTasksDir(cwd, claudeSessionId);
  if (!existsSync(dir)) return [];
  const out: SubagentInfo[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const path = join(dir, name);
    const rec = readFirstRecord(path);
    // a backgrounded shell command's output lives here too — it is plain text,
    // so it fails the JSON parse; and a sidechain record always carries both
    const agentId = rec?.agentId;
    if (rec?.isSidechain !== true || typeof agentId !== 'string' || !agentId) continue;
    let lastAt = '';
    let startedAt = typeof rec.timestamp === 'string' ? rec.timestamp : '';
    try {
      const st = statSync(path);
      lastAt = st.mtime.toISOString();
      if (!startedAt) startedAt = (st.birthtimeMs > 0 ? st.birthtime : st.mtime).toISOString();
    } catch {
      /* vanished between readdir and stat */
    }
    const tail = tailState(path);
    const label = agentLabel(path, agentId);
    out.push({
      agentId,
      task: openingText(rec),
      startedAt,
      lastAt,
      turns: 0,
      done: tail.done,
      ...(label ? { label } : {}),
      ...(tail.activity ? { activity: tail.activity } : {}),
      ...(tail.tokens ? { tokens: tail.tokens } : {}),
    });
  }
  return out.sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) || left.agentId.localeCompare(right.agentId),
  );
}

/** One sub-agent's conversation, as the same Turn blocks the stream renders
 *  for a normal session. */
export function readSubagentTranscript(
  cwd: string,
  claudeSessionId: string,
  agentId: string,
): Turn[] {
  // agentId comes off the wire — keep it to the shape the harness generates so
  // it can never walk out of the tasks directory
  if (!isTaskId(agentId)) return [];
  const path = join(sessionTasksDir(cwd, claudeSessionId), `${agentId}.output`);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const turns: Turn[] = [];
  for (const line of raw.split('\n'))
    turns.push(...parseTranscriptBlocks(line, agentId, turns.length));
  return turns;
}
