import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { type BgTiming, tqdmTiming } from './bg-eta';

/**
 * Progress of a command the session left running in the background.
 *
 * Two things stand between the harness's task output and a progress bar:
 *
 * 1. The output is often not there. A long job is usually started as
 *    `./migrate.sh > migrate.log 2>&1`, so the task's own output file stays
 *    empty and the progress lives in the log. The command line says where.
 * 2. Progress is free text: `进度 2310/6040（812s）`, `45%|████`, `[3/7] …`.
 *    The last such figure in the tail is the one that matters.
 */

export interface BgProgress {
  /** `N/M` */
  done?: number;
  total?: number;
  /** 0–100 */
  pct?: number;
  /** tqdm-style timing — see bg-eta.ts */
  elapsedSec?: number;
  etaSec?: number;
  rate?: number;
}

export interface TaskOrigin {
  command: string;
  /** the call's short name (Bash/Monitor `description`) */
  description: string;
  /** a Monitor — a watcher streaming another command's lines back to claude
   *  ("Monitor started (task <id>"), not work of its own */
  monitor?: boolean;
  /** announced in a sub-agent's log, not the session's */
  bySubagent?: boolean;
  /** that sub-agent's log — its end is the end of what it left running */
  agentLog?: string;
}

/**
 * Every task a transcript has announced, read incrementally.
 *
 * The tool_result announcing "…background with ID: <id>" (or "Monitor started
 * (task <id>") names the tool_use whose input carries the command. This runs
 * on every 2.5s poll for every task the session ever started, so the file is
 * never re-read from the top: each scan continues from where the last one
 * stopped, and a transcript that shrank (rewritten) starts over.
 */
interface Scan {
  offset: number;
  /** the unfinished last line of the previous read — bytes, so a character
   *  split across two reads is not mangled */
  rest: Buffer;
  uses: Map<string, { command: string; description: string }>;
  tasks: Map<string, TaskOrigin>;
  /** tasks the harness has reported over — see NOTICE_RE */
  ended: Set<string>;
}
const scans = new Map<string, Scan>();
// a timed-out foreground command is announced differently: "…was moved to the
// background (ID: b0j90aiu7)"
const ANNOUNCE_RE =
  /(background with ID: |moved to the background \(ID: |Monitor started \(task )([A-Za-z0-9_-]{3,})/g;
/**
 * The harness's notice about a task. A Monitor sends one per EVENT too, and
 * those carry no `<status>`; the notice that it is over does
 * (`completed` / `stopped` / `failed` / `killed` — the only four seen across
 * ~4,400 notices on this machine). So a notice WITH a status is the end.
 * It arrives queued first and delivered later; either record counts. One
 * notice can name MANY tasks — a restart stops every watcher at once and
 * reports them in a single notice, one `<task-id>` each.
 *
 * The other way a task ends is TaskStop, which writes no notice at all, only
 * its result: "Successfully stopped task: <id>". Of 22 Monitors in one real
 * session, 2 ended by a single notice, 14 by one batch notice, and the rest
 * by TaskStop — reading only the first kind left twenty dead watchers
 * "running" in the panel.
 */
const NOTICE_RE = /<task-notification>[\s\S]*?<\/task-notification>/g;
const TASK_ID_RE = /<task-id>([^<]+)<\/task-id>/g;
const STOPPED_RE = /Successfully stopped task: ([A-Za-z0-9_-]{3,})/g;

function scanTranscript(transcript: string): Scan | undefined {
  let size: number;
  try {
    size = statSync(transcript).size;
  } catch {
    return undefined;
  }
  let scan = scans.get(transcript);
  if (!scan || size < scan.offset) {
    scan = {
      offset: 0,
      rest: Buffer.alloc(0),
      uses: new Map(),
      tasks: new Map(),
      ended: new Set(),
    };
    scans.set(transcript, scan);
  }
  if (size === scan.offset) return scan;
  const buf = Buffer.alloc(size - scan.offset);
  let fd: number | undefined;
  try {
    fd = openSync(transcript, 'r');
    readSync(fd, buf, 0, buf.length, scan.offset);
  } catch {
    return scan;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  scan.offset = size;
  const all = Buffer.concat([scan.rest, buf]);
  const cut = all.lastIndexOf(0x0a) + 1;
  for (const line of all.subarray(0, cut).toString('utf8').split('\n')) scanLine(scan, line);
  scan.rest = all.subarray(cut);
  // a last line without its newline is finished once it parses
  if (scan.rest.length && scanLine(scan, scan.rest.toString('utf8'))) scan.rest = Buffer.alloc(0);
  return scan;
}

/** A record's content as text: claude writes a string or a list of blocks. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && 'text' in b ? String(b.text) : ''))
    .join('\n');
}

/** Take in one transcript line; false when it is not (yet) whole JSON. */
function scanLine(scan: Scan, line: string): boolean {
  const hasUse = line.includes('"tool_use"');
  const hasAnnounce =
    line.includes('background with ID: ') ||
    line.includes('moved to the background (ID: ') ||
    line.includes('Monitor started (task ');
  const hasNotice = line.includes('<task-notification>');
  const hasStop = line.includes('Successfully stopped task: ');
  // most lines are none of these — skip the parse
  if (!hasUse && !hasAnnounce && !hasNotice && !hasStop) return line.trimEnd().endsWith('}');
  let o: { type?: string; content?: unknown; message?: { content?: unknown } };
  try {
    o = JSON.parse(line);
  } catch {
    return false;
  }
  if (hasNotice && (o.type === 'user' || o.type === 'queue-operation')) {
    const text = textOf(o.type === 'queue-operation' ? o.content : o.message?.content);
    for (const notice of text.matchAll(NOTICE_RE)) {
      if (!notice[0].includes('<status>')) continue; // a Monitor's event
      for (const id of notice[0].matchAll(TASK_ID_RE)) scan.ended.add((id[1] ?? '').trim());
    }
  }
  // a TaskStop's own result — in a user record only: the model quoting the
  // phrase in its answer must not end anything
  if (hasStop && o.type === 'user') {
    for (const m of JSON.stringify(o.message?.content ?? '').matchAll(STOPPED_RE))
      scan.ended.add(m[1] as string);
  }
  const blocks = Array.isArray(o.message?.content)
    ? (o.message?.content as Record<string, unknown>[])
    : [];
  for (const b of blocks) {
    const input = b.input as { command?: unknown; description?: unknown } | undefined;
    if (b.type === 'tool_use' && typeof b.id === 'string' && typeof input?.command === 'string') {
      scan.uses.set(b.id, {
        command: input.command,
        description: typeof input.description === 'string' ? input.description.trim() : '',
      });
    }
    if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
    const use = scan.uses.get(b.tool_use_id);
    if (!use) continue;
    for (const m of JSON.stringify(b.content ?? '').matchAll(ANNOUNCE_RE)) {
      const monitor = (m[1] as string).startsWith('Monitor');
      scan.tasks.set(m[2] as string, { ...use, ...(monitor ? { monitor } : {}) });
    }
  }
  return true;
}

/** The command a background task id was started with. */
export function backgroundCommand(transcript: string, taskId: string): string | undefined {
  return backgroundTask(transcript, taskId)?.command;
}

/** The command and its short name a task was started with, once announced. */
export function backgroundTask(transcript: string, taskId: string): TaskOrigin | undefined {
  return scanTranscript(transcript)?.tasks.get(taskId);
}

/** A readable name for a command claude gave no `description`: the step that
 *  does the work (after any `cd …&&` / `VAR=…;`), redirections dropped, paths
 *  shortened to their file names. "…/scripts/run_all_proxy.sh > …/x.log 2>&1"
 *  → "run_all_proxy.sh". */
export function commandLabel(command: string): string {
  const steps = command
    .split(/\n|&&|\|\||;/)
    .map((p) => p.trim())
    .filter((p) => p && !/^cd\s/.test(p) && !/^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(p));
  const step = (steps[0] ?? command.trim()).split('|')[0] ?? '';
  const words = step
    .replace(/\s\d?[<>]{1,2}&?\s*\S+/g, '') // > log, 2>&1, >> x
    .trim()
    .split(/\s+/)
    .map((w) => (w.includes('/') ? (w.replace(/\/+$/, '').split('/').pop() ?? w) : w));
  return words.join(' ').slice(0, 80);
}

/** Whether the harness has reported a task as over — for a Monitor, the only
 *  sign it ever gives: its output never gets an exit marker. Looks in the
 *  sub-agents' logs too, as `sessionTask` does. */
export function taskEnded(transcript: string, taskId: string): boolean {
  if (scanTranscript(transcript)?.ended.has(taskId)) return true;
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  let logs: string[];
  try {
    logs = readdirSync(dir).filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl'));
  } catch {
    return false;
  }
  return logs.some((log) => scanTranscript(join(dir, log))?.ended.has(taskId));
}

/** Like `backgroundTask`, but also for the tasks a session's SUB-AGENTS start:
 *  they share the session's tasks directory, yet are announced only in the
 *  sub-agent's own log (`<session>/subagents/agent-<id>.jsonl` beside the
 *  transcript) — looked up in the parent alone, they showed as bare ids and
 *  their Monitors were not recognised (color, 09-17). */
export function sessionTask(transcript: string, taskId: string): TaskOrigin | undefined {
  const own = backgroundTask(transcript, taskId);
  if (own) return own;
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  let logs: string[];
  try {
    logs = readdirSync(dir).filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl'));
  } catch {
    return undefined;
  }
  for (const log of logs) {
    const hit = backgroundTask(join(dir, log), taskId);
    if (hit) return { ...hit, bySubagent: true, agentLog: join(dir, log) };
  }
  return undefined;
}

/**
 * The Bash call still waiting for its result — what an UNANNOUNCED task is.
 * A long foreground command becomes a task file too, but its id never appears
 * in the transcript, so `backgroundTask` cannot name it. Only the transcript's
 * tail is read: the call is recent by definition, and this runs every poll.
 */
export function pendingBashTask(
  transcript: string,
): { command: string; description: string } | undefined {
  const pending = pendingBashCalls(transcript).at(-1);
  return pending ? { command: pending.command, description: pending.description } : undefined;
}

/** Bash calls in a log's tail still waiting for their result, oldest first,
 *  with when each was made. */
export function pendingBashCalls(
  log: string,
): { id: string; command: string; description: string; atMs: number }[] {
  const TAIL = 512 * 1024;
  let text = '';
  let fd: number | undefined;
  try {
    const size = statSync(log).size;
    const take = Math.min(TAIL, size);
    const buf = Buffer.alloc(take);
    fd = openSync(log, 'r');
    readSync(fd, buf, 0, take, size - take);
    text = buf.toString('utf8');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const uses: { id: string; command: string; description: string; atMs: number }[] = [];
  const answered = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let o: { message?: { content?: unknown }; timestamp?: string };
    try {
      o = JSON.parse(line);
    } catch {
      continue; // the cut first line
    }
    const blocks = Array.isArray(o.message?.content)
      ? (o.message?.content as Record<string, unknown>[])
      : [];
    for (const b of blocks) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string')
        answered.add(b.tool_use_id);
      const input = b.input as { command?: unknown; description?: unknown } | undefined;
      if (
        b.type === 'tool_use' &&
        b.name === 'Bash' &&
        typeof b.id === 'string' &&
        typeof input?.command === 'string'
      ) {
        uses.push({
          id: b.id,
          command: input.command,
          description: typeof input.description === 'string' ? input.description.trim() : '',
          atMs: Date.parse(o.timestamp ?? '') || 0,
        });
      }
    }
  }
  return uses.filter((u) => !answered.has(u.id));
}

/** How far a foreground Bash's task file is born after the call is logged:
 *  about a second on 2.1.281 (10:17:34 call, 10:17:35 file). */
const BORN_AFTER_CALL_MS = { min: -3_000, max: 15_000 };

/**
 * Whose call an UNANNOUNCED task is. A long foreground Bash gets a task file
 * but its id is written nowhere until it returns, so the only link is time:
 * the file is born a moment after the call. The session's own log and every
 * sub-agent's are asked; the closest pending call in the window wins.
 * Without this the session's pending Bash was lent to a sub-agent's task,
 * or the task showed as a bare id beside the sub-agent already showing the
 * very same command (09-30).
 */
export function unannouncedTask(
  transcript: string,
  startedAtMs: number | undefined,
): (TaskOrigin & { atMs: number }) | undefined {
  if (!startedAtMs) return undefined;
  const logs: { path: string; agent: boolean }[] = [{ path: transcript, agent: false }];
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  try {
    for (const n of readdirSync(dir))
      if (n.startsWith('agent-') && n.endsWith('.jsonl'))
        logs.push({ path: join(dir, n), agent: true });
  } catch {
    /* no sub-agents */
  }
  let best: (TaskOrigin & { atMs: number }) | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const log of logs) {
    try {
      // a log untouched since before the task began cannot hold its call
      if (statSync(log.path).mtimeMs < startedAtMs + BORN_AFTER_CALL_MS.min) continue;
    } catch {
      continue;
    }
    for (const call of pendingBashCalls(log.path)) {
      const gap = startedAtMs - call.atMs;
      if (gap < BORN_AFTER_CALL_MS.min || gap > BORN_AFTER_CALL_MS.max) continue;
      if (Math.abs(gap) >= bestGap) continue;
      bestGap = Math.abs(gap);
      best = {
        command: call.command,
        description: call.description,
        atMs: call.atMs,
        ...(log.agent ? { bySubagent: true, agentLog: log.path } : {}),
      };
    }
  }
  return best;
}

/**
 * Files the command writes its stdout to: `> f`, `>> f`, `&> f`, `1> f`,
 * `| tee [-a] f`. Relative paths resolve against a leading `cd DIR &&` or
 * the session's cwd. `2> f` (stderr only) and /dev/null are not progress.
 */
/** Variables a command sets, the command without its leading assignments,
 *  and the directory relative paths in it resolve against. */
function shellContext(
  command: string,
  cwd: string,
): { vars: Map<string, string>; body: string; base: string } {
  // `LOG=/…/run.log; … > $LOG` — told to log long jobs, sessions name the log
  // in a variable first, so plain assignments are expanded into the targets
  const vars = new Map<string, string>([['HOME', homedir()]]);
  for (const m of command.matchAll(
    /(?:^|[\n;&])\s*([A-Za-z_]\w*)=("[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/g,
  )) {
    vars.set(m[1] as string, expand((m[2] as string).replace(/^["']|["']$/g, ''), vars));
  }
  // leading assignments are not the command — a `cd` after them still leads
  const body = command.replace(
    /^\s*(?:[A-Za-z_]\w*=(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)\s*(?:\n|;|&&)\s*)+/,
    '',
  );
  const leadRaw = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(body)?.[1];
  const lead = leadRaw ? expand(leadRaw.replace(/^["']|["']$/g, ''), vars) : undefined;
  const base = lead ? (isAbsolute(lead) ? lead : join(cwd, lead)) : cwd;
  return { vars, body, base };
}

function collect(
  raws: Iterable<string | undefined>,
  vars: Map<string, string>,
  base: string,
): string[] {
  const out: string[] = [];
  for (const raw of raws) {
    const p = raw ? expand(raw.replace(/^["']|["']$/g, ''), vars) : undefined;
    if (!p || p === '/dev/null' || p === '-' || p.startsWith('&') || p.includes('$')) continue;
    const abs = isAbsolute(p) ? p : join(base, p);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

export function redirectTargets(command: string, cwd: string): string[] {
  const { vars, body, base } = shellContext(command, cwd);
  return collect(
    [
      ...[...body.matchAll(/(?:^|[\s;&|])(?:&|1)?>>?\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)].map(
        (m) => m[1],
      ),
      ...[...body.matchAll(/\|\s*tee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)].map((m) => m[1]),
    ],
    vars,
    base,
  );
}

/**
 * Files a silent command is filling: `curl -o F` / `--output F`, `wget -O F`.
 * `curl -sL -o big.7z …` prints nothing at all; the growing file is the only
 * sign of life, so its size is what the view shows.
 */
export function outputFiles(command: string, cwd: string): string[] {
  const { vars, body, base } = shellContext(command, cwd);
  const raws: (string | undefined)[] = [];
  for (const seg of body.split(/&&|\|\||;|\n|\|/)) {
    const tool = /^\s*(?:sudo\s+)?(\S+)/.exec(seg)?.[1] ?? '';
    const name = tool.split('/').pop();
    const flag =
      name === 'curl'
        ? /(?:^|\s)(?:-[A-Za-z]*o|--output)(?:\s+|=)("[^"]+"|'[^']+'|\S+)/g
        : name === 'wget'
          ? /(?:^|\s)(?:-O|--output-document)(?:\s+|=)("[^"]+"|'[^']+'|\S+)/g
          : undefined;
    if (!flag) continue;
    for (const m of seg.matchAll(flag)) raws.push(m[1]);
  }
  return collect(raws, vars, base);
}

/** `$NAME` / `${NAME}` / a leading `~`, from the values known; unknown stay */
function expand(s: string, vars: Map<string, string>): string {
  return s
    .replace(/^~(?=\/|$)/, vars.get('HOME') ?? '~')
    .replace(
      /\$\{(\w+)\}|\$(\w+)/g,
      (all, a: string | undefined, b: string | undefined) => vars.get(a ?? b ?? '') ?? all,
    );
}

/** Of the targets, the one written most recently — a chained `a > x.log;
 *  b > y.log` is on whichever log is still growing. */
export function liveTarget(targets: string[]): string | undefined {
  let best: { path: string; at: number } | undefined;
  for (const path of targets) {
    try {
      if (!existsSync(path)) continue;
      const st = statSync(path);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.at) best = { path, at: st.mtimeMs };
    } catch {
      /* unreadable */
    }
  }
  return best?.path;
}

/** a labelled running count: `进度308`, `已完成: 12`, `progress 40`, `done=7`.
 *  The label is required — a bare number in a status line is anything. */
const COUNT_RE =
  /(?:进度|已完成|完成数|progress|processed|done)\s*[:：=]?\s*(\d{1,9})(?![\d.%/:\w])/gi;

/** The last progress figure in a tail of output, and the last line worth
 *  showing — '' when that line IS the progress line: the figure is already
 *  on screen, and repeating the raw `count: 95%|████| 19/20` under it is noise. */
export function progressOf(text: string): {
  progress?: BgProgress;
  lastLine: string;
  /** the progress line's own tqdm `elapsed<remaining`, when it prints one */
  tqdm?: BgTiming;
} {
  const lines = text
    .split(/\r?\n|\r/) // tqdm redraws with \r
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal colour codes
    .map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim())
    .filter((l) => l && !/^\[(?:exited with code -?\d+|killed)\]$/.test(l));
  const lastLine = (lines.at(-1) ?? '').slice(0, 200);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 40; i--) {
    const l = lines[i] as string;
    const frac = [...l.matchAll(/(?<![\w/.:-])(\d{1,9})\s*\/\s*(\d{1,9})(?![\w/.:-])/g)]
      .map((m) => ({ done: Number(m[1]), total: Number(m[2]) }))
      .filter((f) => f.total > 0 && f.done <= f.total)
      .at(-1);
    const pctM = [...l.matchAll(/(?<![\w.])(\d{1,3}(?:\.\d+)?)\s*%/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n <= 100)
      .at(-1);
    const shown = i === lines.length - 1 ? '' : lastLine;
    const tq = frac || pctM !== undefined ? tqdmTiming(l) : undefined;
    const tqdm = tq ? { tqdm: tq } : {};
    if (frac) {
      const pct = pctM ?? Math.round((frac.done / frac.total) * 1000) / 10;
      return { progress: { ...frac, pct }, lastLine: shown, ...tqdm };
    }
    if (pctM !== undefined) return { progress: { pct: pctM }, lastLine: shown, ...tqdm };
    // a count with no total (`进度308`, `done: 12`) — worth a figure and a
    // rate, though no bar and no time left
    const count = [...l.matchAll(COUNT_RE)].map((m) => Number(m[1])).at(-1);
    if (count !== undefined) return { progress: { done: count }, lastLine: shown };
  }
  return { lastLine };
}

/** `path/to/file.log:` at the start of a line — grep's prefix when it reads
 *  several files, and how a watcher that polls several logs tells them apart */
const SOURCE_RE = /^([\w.~@+-][\w.~@+/-]*\.[A-Za-z0-9]{1,8}):(?!\/\/)/;

/**
 * Progress per source, for output that interleaves several logs: a Monitor
 * grepping `progress.log` (340/528) and `upload_levels.log` (50/863) in one
 * loop. Read as one stream, the figure jumped between the two every poll, so
 * it was not read at all (09-30); per source, each gets its own bar. The
 * prefix is taken off each line, so a timestamp behind it still dates the
 * figure. Sources in the order they last spoke, oldest first.
 */
export function progressBySource(
  text: string,
): { source: string; progress: BgProgress; text: string; tqdm?: BgTiming }[] {
  const bySource = new Map<string, string[]>();
  for (const raw of text.split(/\r?\n/)) {
    const m = SOURCE_RE.exec(raw.trim());
    if (!m?.[1]) continue;
    const source = m[1];
    const rest = raw.trim().slice(m[0].length);
    const lines = bySource.get(source) ?? [];
    bySource.delete(source); // re-insert: Map order = order of last line
    bySource.set(source, [...lines, rest]);
  }
  const out: { source: string; progress: BgProgress; text: string; tqdm?: BgTiming }[] = [];
  for (const [source, lines] of bySource) {
    const body = lines.join('\n');
    const p = progressOf(body);
    if (p.progress) out.push({ source, progress: p.progress, text: body, ...(p.tqdm ? { tqdm: p.tqdm } : {}) });
  }
  return out;
}

/** Existing files with their current size. */
export function fileSizes(paths: string[]): { path: string; bytes: number; mtimeMs: number }[] {
  const out: { path: string; bytes: number; mtimeMs: number }[] = [];
  for (const path of paths) {
    try {
      const st = statSync(path);
      if (st.isFile()) out.push({ path, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* not created yet */
    }
  }
  return out;
}

/** "Writing ComfyUI.7z · 812.4 MB" — the bar's line for a silent download */
export function writingLine(
  files: { path: string; bytes: number; mtimeMs?: number }[] | undefined,
): string {
  // the one still being written — earlier files of a chain are already done
  const f = [...(files ?? [])].sort((a, b) => (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0)).at(-1);
  if (!f) return '';
  const mb = f.bytes / (1024 * 1024);
  const size =
    mb >= 1024
      ? `${(mb / 1024).toFixed(2)} GB`
      : mb >= 1
        ? `${mb.toFixed(1)} MB`
        : `${Math.round(f.bytes / 1024)} KB`;
  return `Writing ${f.path.split('/').pop()} · ${size}`;
}
