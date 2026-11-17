import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Turn } from '@ateam/contract';
import { modelPrice, usageCostUsd } from '../model-pricing';
import { claudeProjectDir } from './claude-sessions';
import { modelIdFromSetLine } from './model-command';
import { peerToolName } from './peer-tools';

/** Read up to `bytes` from the head or tail of a file (transcripts are big;
 *  never slurp the whole multi-MB jsonl). Drops the partial boundary line. */
/** A byte window ending at `endByte` (exclusive), whole-line aligned.
 *  Powers "load older history": each call walks another window back. */
export function readWindowBefore(
  path: string,
  endByte: number,
  bytes: number,
): { lines: string[]; fromByte: number } {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const end = Math.max(0, Math.min(endByte, size));
    const len = Math.min(bytes, end);
    const pos = end - len;
    if (len <= 0) return { lines: [], fromByte: 0 };
    const buf = Buffer.alloc(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, pos);
    const text = buf.toString('utf8');
    // A window that starts mid-file begins with a partial line — drop it AND
    // report the boundary where the first WHOLE line begins. Reporting `pos`
    // instead would leave the next window's last line cut in half (the
    // caller walks backwards using this value as its next end).
    let start = 0;
    if (pos > 0) {
      const nl = text.indexOf('\n');
      if (nl < 0) return { lines: [], fromByte: pos }; // one huge line: skip on
      start = nl + 1;
    }
    const fromByte = pos + Buffer.byteLength(text.slice(0, start), 'utf8');
    // A single record bigger than the window: its only newline is the one
    // terminating it, so the "prefix" ate the whole window and fromByte
    // would equal `endByte` — the caller would ask for the same window
    // forever. Skip the window instead; progress beats one giant record.
    if (fromByte >= end) return { lines: [], fromByte: pos };
    return { lines: text.slice(start).split('\n').filter(Boolean), fromByte };
  } catch {
    return { lines: [], fromByte: 0 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readChunk(path: string, bytes: number, fromEnd: boolean): string[] {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const len = Math.min(bytes, size);
    const pos = fromEnd ? Math.max(0, size - len) : 0;
    const buf = Buffer.alloc(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, pos);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (fromEnd && pos > 0)
      lines.shift(); // drop partial first line
    else if (!fromEnd && len < size) lines.pop(); // drop partial last line
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The flywheel's real input: Claude Code's on-disk session transcript
 * (`~/.claude/projects/<slug>/<sessionId>.jsonl`), parsed into structured
 * turns — lossless, unlike scraping the interactive PTY.
 */
export function transcriptPath(cwd: string, sessionId: string): string {
  return join(claudeProjectDir(cwd), `${sessionId}.jsonl`);
}

/** ISO birthtime of the claude transcript jsonl for a session (real session
 *  lifetime start). Falls back to mtime if birthtime is unavailable (some FS
 *  report 0). '' if the transcript does not exist yet. */
export function claudeCreatedAt(cwd: string, sessionId: string): string {
  const path = transcriptPath(cwd, sessionId);
  if (!existsSync(path)) return '';
  try {
    const st = statSync(path);
    const birth = st.birthtimeMs > 0 ? st.birthtime : st.mtime;
    return birth.toISOString();
  } catch {
    return '';
  }
}

/** ISO timestamp of the newest *timestamped* record in the claude transcript
 *  jsonl — the session's real last activity. File mtime CANNOT serve here:
 *  claude appends timestamp-less metadata records (agent-name, mode,
 *  permission-mode, last-prompt) on every resume/quit, so after an app
 *  restart every restored session's mtime reads "just now" and a
 *  recently-active filter keyed on it hides nothing. Scans a bounded tail
 *  window backwards for the first record carrying a `timestamp`. '' when
 *  the transcript is missing or no timestamped record is in the window. */
export function claudeLastActiveAt(cwd: string, sessionId: string): string {
  const path = transcriptPath(cwd, sessionId);
  return derivedFromFile(path, 'lastActive', () => computeClaudeLastActiveAt(path));
}

function computeClaudeLastActiveAt(path: string): string {
  if (!existsSync(path)) return '';
  const lines = readChunk(path, 256 * 1024, true);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as Line;
      if (typeof rec.timestamp === 'string' && rec.timestamp) return rec.timestamp;
    } catch {
      /* partial or non-JSON line — keep scanning */
    }
  }
  return '';
}

export interface TranscriptUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** what those tokens bill at list price, per record's own model */
  costUsd: number;
  /** tokens on a model we could not price (counted above, $0 below) */
  unpricedTokens: number;
}

/** Sum the per-request `message.usage` blocks of a session transcript —
 *  the API-billed reality (usage.recent only logs the flywheel's calls).
 *  Reads the whole jsonl; on-demand from the tokens tab, so a few MB is
 *  acceptable. */
export function transcriptUsage(cwd: string, sessionId: string): TranscriptUsage {
  const out: TranscriptUsage = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    unpricedTokens: 0,
  };
  const path = transcriptPath(cwd, sessionId);
  if (!existsSync(path)) return out;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const ln of text.split('\n')) {
    if (!ln.includes('"usage"')) continue;
    try {
      const o = JSON.parse(ln) as {
        type?: string;
        message?: { usage?: Record<string, unknown>; model?: string };
      };
      const u = o.type === 'assistant' ? o.message?.usage : undefined;
      if (!u) continue;
      const rec = {
        inputTokens: Number(u.input_tokens) || 0,
        outputTokens: Number(u.output_tokens) || 0,
        cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
        cacheCreationTokens: Number(u.cache_creation_input_tokens) || 0,
      };
      out.turns++;
      out.inputTokens += rec.inputTokens;
      out.outputTokens += rec.outputTokens;
      out.cacheReadTokens += rec.cacheReadTokens;
      out.cacheCreationTokens += rec.cacheCreationTokens;
      const model = o.message?.model;
      if (modelPrice(model)) out.costUsd += usageCostUsd(model, rec);
      else
        out.unpricedTokens +=
          rec.inputTokens + rec.outputTokens + rec.cacheReadTokens + rec.cacheCreationTokens;
    } catch {
      /* partial or non-JSON line */
    }
  }
  return out;
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  content?: unknown;
  input?: unknown;
  thinking?: string;
  id?: string;
  tool_use_id?: string;
}
/** one hunk as claude's records keep it — unvalidated */
interface RawHunk {
  oldStart?: unknown;
  newStart?: unknown;
  lines?: unknown;
}

interface Line {
  type?: string;
  timestamp?: string;
  summary?: string;
  message?: { role?: string; content?: unknown; usage?: { output_tokens?: number } };
  /** queue-operation records: a message typed MID-TURN is stored as an
   *  enqueue op (content = the prompt), not as a user message */
  operation?: string;
  content?: unknown;
  /** attachment records; `queued_command` = a queued message claude took up
   *  MID-TURN (its text is here and nowhere else) */
  attachment?: { type?: string; prompt?: unknown };
  /** claude's own record of a failed API call ("API Error: …") */
  isApiErrorMessage?: boolean;
  /** the harness injected this "user" record — the person did not type it */
  isMeta?: boolean;
  /** the summary claude wrote when it compacted its own context ("This
   *  session is being continued from a previous conversation…") */
  isCompactSummary?: boolean;
  /** Edit/Write results carry the change itself here — NOT in the message */
  toolUseResult?: {
    /** 'create' = a Write that made a new file (no diff, the content IS it),
     *  'update' = a Write over an existing one (a diff, like Edit) */
    type?: unknown;
    filePath?: unknown;
    content?: unknown;
    structuredPatch?: RawHunk[];
    /** a bash command that edited files records its own diff, per file */
    bashEditDiff?: { files?: { filePath?: unknown; hunks?: RawHunk[] }[] };
  };
}

/**
 * What claude wraps a PASTE in before storing it:
 *
 *     <pasted_content id="c40d">
 *     flux 的重绘 好像把原图变模糊了
 *     </pasted_content id="c40d">
 *
 * (the closing tag repeats the id — not valid markup, and not a typo here).
 * The stream sent every message as a bracketed paste, so ordinary sentences
 * came back dressed in it and showed as tags in the conversation. The wrapper
 * is plumbing: keep what the user wrote.
 */
const PASTED_RE = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content(?: id="\1")?>/g;

/**
 * claude's bash mode (a line typed after `!`) is stored as two user records:
 * `<bash-input>cmd</bash-input>`, then
 * `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`. The terminal
 * draws them as a command and its output; the stream showed the raw tags in
 * the person's own bubble, with a pm2 table wrapped into a paragraph. Read
 * them as what they are — a tool call and its result — and every card,
 * fold and run-merge in the view applies to them for free.
 */
export function bashModeRecord(
  text: string,
): { kind: 'input'; text: string } | { kind: 'output'; text: string } | null {
  const t = text.trim();
  const input = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(t);
  if (input) return { kind: 'input', text: (input[1] ?? '').trim() };
  if (!t.startsWith('<bash-stdout>')) return null;
  const out = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(t)?.[1] ?? '';
  const err = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(t)?.[1] ?? '';
  const body = [out.trim(), err.trim()].filter(Boolean).join('\n');
  return { kind: 'output', text: body };
}

export function unwrapPasted(text: string): string {
  return text.includes('<pasted_content') ? text.replace(PASTED_RE, '$2').trim() : text;
}

function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as Block[]) {
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'tool_use') parts.push(`[tool: ${b.name ?? 'unknown'}]`);
    else if (b.type === 'tool_result') {
      const c = b.content;
      const s = typeof c === 'string' ? c : JSON.stringify(c);
      parts.push(`[result] ${s.slice(0, 600)}`);
    }
  }
  return parts.join('\n');
}

const HANDOFF_INTRO = 'I am taking over from a previous session that hit the context limit.';

/** Handoff prompts are user-shaped records. Match their complete framing so
 *  ordinary user messages that merely mention a handoff remain ordinary. */
function handoffMessage(text: string): boolean {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines[0] !== HANDOFF_INTRO) return false;
  const starts = lines.flatMap((line, index) => (line === '--- HANDOFF ---' ? [index] : []));
  const ends = lines.flatMap((line, index) => (line === '--- END HANDOFF ---' ? [index] : []));
  if (starts.length !== 1 || ends.length !== 1) return false;
  const start = starts[0] ?? -1;
  const end = ends[0] ?? -1;
  return start > 0 && end === lines.length - 1 && end > start;
}

/** The change an Edit/Write — or a bash command — made, as the record keeps
 *  it. Capped: a rewritten file can be thousands of lines, and this rides in
 *  every transcript reply. */
const PATCH_LINE_CAP = 400;

type FilePatch = NonNullable<Turn['patch']>[number];

/** One file's hunks, trimmed to `budget` lines. What the budget cut is
 *  counted, not dropped silently — a diff that just stops reads like the
 *  whole change. */
function filePatch(file: string, raw: RawHunk[], budget: number): FilePatch | undefined {
  let left = budget;
  let dropped = 0;
  const hunks: { oldStart: number; newStart: number; lines: string[] }[] = [];
  for (const h of raw) {
    const lines = (Array.isArray(h?.lines) ? h.lines : []).filter(
      (l): l is string => typeof l === 'string',
    );
    if (lines.length === 0) continue;
    if (left <= 0) {
      dropped += lines.length;
      continue;
    }
    hunks.push({
      oldStart: Number(h?.oldStart) || 0,
      newStart: Number(h?.newStart) || 0,
      lines: lines.slice(0, left),
    });
    dropped += Math.max(0, lines.length - left);
    left -= lines.length;
  }
  if (hunks.length === 0 && dropped === 0) return undefined;
  return { file, hunks, ...(dropped > 0 ? { dropped } : {}) };
}

function patchOf(o: Line): Turn['patch'] | undefined {
  const r = o.toolUseResult;
  if (!r) return undefined;
  const file = typeof r.filePath === 'string' ? r.filePath : '';
  const structured = Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
  if (structured.length > 0) {
    const p = filePatch(file, structured, PATCH_LINE_CAP);
    return p ? [p] : undefined;
  }
  // A Write that CREATES a file has no diff to record — `structuredPatch` is
  // empty and the whole content is the change. The terminal previews it; the
  // card used to say only what the result said, "has been created".
  if (r.type === 'create' && typeof r.content === 'string' && r.content.length > 0) {
    const lines = r.content.replace(/\n$/, '').split('\n');
    const p = filePatch(
      file,
      [{ oldStart: 0, newStart: 1, lines: lines.map((l) => `+${l}`) }],
      PATCH_LINE_CAP,
    );
    return p ? [p] : undefined;
  }
  // a bash command that edited files (a heredoc, sed -i, `git apply`) keeps
  // its own diff, one entry per file — the terminal draws those too, and
  // several files in one command is ordinary
  const edited = r.bashEditDiff?.files;
  if (Array.isArray(edited) && edited.length > 0) {
    let left = PATCH_LINE_CAP;
    const out: FilePatch[] = [];
    for (const f of edited) {
      const p = filePatch(
        typeof f?.filePath === 'string' ? f.filePath : '',
        Array.isArray(f?.hunks) ? f.hunks : [],
        left,
      );
      if (!p) continue;
      out.push(p);
      left -= p.hunks.reduce((n, h) => n + h.lines.length, 0);
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/** Parse ONE transcript jsonl line into a Turn (undefined for records that
 *  carry no message content — titles, meta, blank/partial lines). */
export function parseTranscriptLine(
  line: string,
  sessionId: string,
  seq: number,
): Turn | undefined {
  if (!line.trim()) return undefined;
  let o: Line;
  try {
    o = JSON.parse(line) as Line;
  } catch {
    return undefined;
  }
  // Claude Code 2.1.300+ writes a snapshot of the API request as its own
  // record, shaped like a message (role user, tool_results plus the harness's
  // "The user sent a new message while you were working" wrapper). It is not
  // conversation; read as one it showed the wrapper as something the person
  // said and drew every tool card of the request a second time.
  if (o.type === 'api-request-blob') return undefined;
  const at = o.timestamp ?? '';
  if (o.type === 'summary' && o.summary) {
    return { seq, sessionId, role: 'system', text: o.summary, at };
  }
  const msg = o.message;
  if (!msg) return undefined;
  const text = blocksToText(msg.content).trim();
  if (!text) return undefined;
  const role: Turn['role'] =
    msg.role === 'assistant'
      ? 'assistant'
      : msg.role === 'user'
        ? text.startsWith('[result]')
          ? 'tool'
          : 'user'
        : 'system';
  return { seq, sessionId, role, text, at };
}

/** The one input field worth showing in a tool card's header. */
export function toolInputSummary(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.length > 200 ? `${v.slice(0, 200)}…` : v;
  }
  const j = JSON.stringify(o);
  return j === '{}' ? '' : j.length > 200 ? `${j.slice(0, 200)}…` : j;
}

/** Parse ONE transcript jsonl line into BLOCK-LEVEL turns: a message that
 *  interleaves text, thinking and tool calls becomes one Turn per block, so
 *  the stream view can render each the way other AI IDEs do (tool cards,
 *  collapsed thinking) instead of a flattened "[tool: X]" blob. `nextSeq`
 *  is the seq of the first emitted turn; the caller advances its counter by
 *  the returned length. */
export function parseTranscriptBlocks(line: string, sessionId: string, nextSeq: number): Turn[] {
  if (!line.trim()) return [];
  let o: Line;
  try {
    o = JSON.parse(line) as Line;
  } catch {
    return [];
  }
  if (o.type === 'api-request-blob') return []; // request snapshot, not conversation
  const at = o.timestamp ?? '';
  if (o.type === 'summary' && o.summary) {
    return [{ seq: nextSeq, sessionId, role: 'system', text: o.summary, at, kind: 'text' }];
  }
  // A message the user typed while the model was mid-turn is QUEUED. The
  // queue is three records: `enqueue` (with the text), then either `dequeue`
  // (no text — the oldest queued message was taken at a turn boundary, and a
  // normal user record with that text follows) or `remove` (with the text —
  // taken mid-turn, and a `queued_command` attachment carries it into the
  // conversation). The stream view keeps enqueued messages in a tray at the
  // bottom and moves each into the conversation where claude took it up.
  if (o.type === 'queue-operation') {
    // a queued message is stored the way it was typed — through a paste, that
    // is inside <pasted_content> tags, which made it look machine-injected and
    // the queue tray dropped it (09-21)
    const body = typeof o.content === 'string' ? unwrapPasted(o.content.trim()) : '';
    if (o.operation === 'dequeue') {
      return [
        { seq: nextSeq, sessionId, role: 'user', text: '', at, kind: 'text', dequeued: true },
      ];
    }
    if (!body) return [];
    if (o.operation === 'enqueue') {
      return [
        { seq: nextSeq, sessionId, role: 'user', text: body, at, kind: 'text', queued: true },
      ];
    }
    // remove = taken mid-turn; popAll = the user pressed Up and pulled it back
    // into the input box to edit (it returns, if at all, as a new enqueue).
    // Either way it leaves the queue; only remove is followed by the message.
    if (o.operation === 'remove' || o.operation === 'popAll') {
      return [
        { seq: nextSeq, sessionId, role: 'user', text: body, at, kind: 'text', dequeued: true },
      ];
    }
    return [];
  }
  if (o.type === 'attachment' && o.attachment?.type === 'queued_command') {
    // the same paste shell as the queue records — left on, a message Ateam
    // typed in (the experience checkpoint) did not read as Ateam's and was
    // drawn in full as the person's bubble (09-24)
    const body = unwrapPasted(blocksToText(o.attachment.prompt).trim());
    return body
      ? [
          {
            seq: nextSeq,
            sessionId,
            role: 'user',
            text: body,
            at,
            kind: 'text',
            injected: handoffMessage(body) ? 'handoff' : 'mid_turn',
          },
        ]
      : [];
  }
  const msg = o.message;
  if (!msg) return [];
  const baseRole: Turn['role'] =
    msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : 'system';
  const notice = o.isApiErrorMessage ? { notice: 'error' as const } : {};
  // the harness labels its own injections; without that the view had to know
  // each one by its wording, and the newest — "your response was stopped by a
  // safety classifier" — was shown as something the person had said
  const meta = baseRole === 'user' && o.isMeta === true ? { meta: true as const } : {};
  // claude's own compaction summary is a "user" record the person never typed;
  // as a bubble it read as their words and as pages of them
  const compaction =
    baseRole === 'user' && o.isCompactSummary === true ? { injected: 'compaction' as const } : {};
  const out: Turn[] = [];
  const tokens = msg.usage?.output_tokens;
  const push = (t: Omit<Turn, 'seq' | 'sessionId' | 'at'>): void => {
    // usage rides on the record's FIRST turn only — summing turns then
    // counts each record once
    const extra = out.length === 0 && typeof tokens === 'number' ? { tokens } : {};
    out.push({ seq: nextSeq + out.length, sessionId, at, ...extra, ...t });
  };
  if (typeof msg.content === 'string') {
    const plain = unwrapPasted(msg.content.trim());
    const bash = baseRole === 'user' ? bashModeRecord(plain) : null;
    if (bash)
      push(
        bash.kind === 'input'
          ? { role: 'tool', text: bash.text, kind: 'tool_use', toolName: 'Bash' }
          : { role: 'tool', text: bash.text, kind: 'tool_result' },
      );
    else if (plain)
      push({
        role: baseRole,
        text: plain,
        kind: 'text',
        ...notice,
        ...meta,
        ...(baseRole === 'user' && handoffMessage(plain) ? { injected: 'handoff' as const } : {}),
        ...compaction,
      });
    return out;
  }
  if (!Array.isArray(msg.content)) return [];
  for (const b of msg.content as Block[]) {
    if (b.type === 'text' && b.text?.trim()) {
      // A message with a PICTURE attached is stored as a block list, not as a
      // plain string — and the paste wrapper was only unwrapped on the string
      // branch. So exactly the messages that carry a photo came back dressed
      // in <pasted_content> tags: shown raw in the bubble, and different
      // enough from what was sent that the view could not pair the two
      // (the optimistic bubble then pulsed for a minute and vanished).
      const text = unwrapPasted(b.text.trim());
      push({
        role: baseRole,
        text,
        kind: 'text',
        ...notice,
        ...meta,
        ...(baseRole === 'user' && handoffMessage(text) ? { injected: 'handoff' as const } : {}),
        ...compaction,
      });
    } else if (b.type === 'thinking' && b.thinking?.trim()) {
      push({ role: 'assistant', text: b.thinking.trim(), kind: 'thinking' });
    } else if (b.type === 'tool_use') {
      // AskUserQuestion carries its full input: the stream view renders the
      // questions as TAPPABLE options (a digit keypress answers the TUI
      // picker), which needs the structure, not a one-line summary
      const full = b.name === 'AskUserQuestion';
      const fullJson = full ? JSON.stringify(b.input ?? {}) : '';
      const desc = (b.input as { description?: unknown } | undefined)?.description;
      push({
        role: 'tool',
        text: full ? fullJson.slice(0, 6000) : toolInputSummary(b.input),
        kind: 'tool_use',
        toolName: peerToolName(b.name ?? '') ?? b.name ?? 'tool',
        ...(b.id ? { toolUseId: b.id } : {}),
        ...(typeof desc === 'string' && desc.trim() ? { label: desc.trim().slice(0, 120) } : {}),
      });
    } else if (b.type === 'tool_result') {
      const c = b.content;
      let text: string;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c))
        text = (c as Block[])
          .map((x) => (x.type === 'text' && x.text ? x.text : ''))
          .filter(Boolean)
          .join('\n');
      else text = c === undefined ? '' : JSON.stringify(c);
      text = text.trim();
      const patch = patchOf(o);
      push({
        role: 'tool',
        text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
        kind: 'tool_result',
        ...(patch ? { patch } : {}),
        ...(b.tool_use_id ? { toolUseId: b.tool_use_id } : {}),
      });
    }
  }
  return out;
}

export function readClaudeTranscript(cwd: string, sessionId: string): Turn[] {
  const path = transcriptPath(cwd, sessionId);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const turns: Turn[] = [];
  for (const line of raw.split('\n')) {
    turns.push(...parseTranscriptBlocks(line, sessionId, turns.length));
  }
  return turns;
}

const cleanTitle = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 48) : '';

/**
 * The session's own title from its transcript file (absolute path).
 * Confirmed against a real renamed transcript: the `/rename` slash command
 * does NOT write `ai-title` — it appends two tiny records per invocation:
 *   {type:"custom-title", customTitle:"<name>", sessionId}
 *   {type:"agent-name",   agentName:"<name>",  sessionId}
 * The AI auto-title is a separate {type:"ai-title", aiTitle} record.
 * An explicit user rename wins over the auto-title; within each kind the
 * latest record wins. Scan the TAIL (these records are appended). '' if none.
 */
export function claudeTitleFromPath(path: string): string {
  if (!existsSync(path)) return '';
  let aiTitle = '';
  let userTitle = '';
  for (const ln of readChunk(path, 96 * 1024, true)) {
    try {
      const o = JSON.parse(ln) as {
        type?: string;
        aiTitle?: string;
        customTitle?: string;
        agentName?: string;
      };
      if (o.type === 'ai-title' && o.aiTitle) aiTitle = cleanTitle(o.aiTitle);
      else if (o.type === 'custom-title' && o.customTitle) userTitle = cleanTitle(o.customTitle);
      else if (o.type === 'agent-name' && o.agentName) userTitle = cleanTitle(o.agentName);
    } catch {
      /* skip */
    }
  }
  return userTitle || aiTitle;
}

/** A short session name from claude's own transcript. Priority:
 *  explicit `/rename` (latest wins) > AI auto-title > summary > first user msg. */

/**
 * A value derived from a transcript, recomputed only when the file actually
 * changed.
 *
 * `session.list()` runs these for EVERY session on every call, and the tree is
 * refreshed once per restored session plus every 5s forever — with 58 sessions
 * that measured ~38ms of synchronous work per refresh, all of it on the
 * sidecar's single thread, competing with the PTY output of the very sessions
 * being restored. A transcript that has not moved cannot have produced a
 * different answer, so one stat replaces the read.
 *
 * Keyed on mtime AND size: coarse filesystem timestamps can repeat, and a
 * rewrite that lands in the same millisecond still changes the length.
 */
const derived = new Map<string, { mtimeMs: number; size: number; value: string }>();
/** bound: one entry per (file, kind); evicts oldest-first */
const MAX_DERIVED = 600;

function derivedFromFile(path: string, kind: string, compute: () => string): string {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(path);
  } catch {
    return ''; // missing transcript — nothing to derive, nothing to cache
  }
  const key = `${kind}\u0000${path}`;
  const hit = derived.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  const value = compute();
  if (derived.size >= MAX_DERIVED) {
    const oldest = derived.keys().next().value;
    if (oldest !== undefined) derived.delete(oldest);
  }
  derived.set(key, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

/** The model this session is actually talking to, as the CLI records it on
 *  every assistant message ("claude-opus-5"). Read from the TAIL, because
 *  /model is session-scoped and can change mid-conversation — the last record
 *  wins, and an older one would show a model the session no longer uses.
 *  '' when nothing has come back yet (a session that has not answered once). */
export function claudeModel(cwd: string, sessionId: string): string {
  const path = transcriptPath(cwd, sessionId);
  return derivedFromFile(path, 'model', () => computeClaudeModel(path));
}

function computeClaudeModel(path: string): string {
  if (!existsSync(path)) return '';
  const tail = readChunk(path, 256 * 1024, true);
  // Walk back and take whichever came LAST: a model that answered, or a
  // /model switch. A switch writes no assistant record, so without the second
  // case the session shows the model it just left until it answers again —
  // which is what the user sees when they change the model and nothing moves.
  for (let i = tail.length - 1; i >= 0; i--) {
    const ln = tail[i];
    if (!ln) continue;
    if (ln.includes('"model"')) {
      try {
        const o = JSON.parse(ln) as { message?: { model?: string } };
        const m = o.message?.model;
        // the CLI stamps its own synthetic records with a placeholder
        if (m && m !== '<synthetic>') return m;
      } catch {
        /* partial line at the chunk boundary */
      }
    }
    if (ln.includes('Set model to')) {
      try {
        const o = JSON.parse(ln) as { message?: { content?: unknown } };
        const switched = modelIdFromSetLine(textOfContent(o.message?.content));
        if (switched) return switched;
      } catch {
        /* partial line at the chunk boundary */
      }
    }
  }
  return '';
}

/** A record's message content as plain text — claude writes it as a string or
 *  as a list of blocks depending on the record. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : '',
    )
    .join(' ');
}

export function claudeSummary(cwd: string, sessionId: string): string {
  const path = transcriptPath(cwd, sessionId);
  return derivedFromFile(path, 'summary', () => computeClaudeSummary(path));
}

function computeClaudeSummary(path: string): string {
  if (!existsSync(path)) return '';
  const clean = cleanTitle;

  const title = claudeTitleFromPath(path);
  if (title) return title;

  const head = readChunk(path, 32 * 1024, false).slice(0, 40);
  for (const ln of head) {
    try {
      const o = JSON.parse(ln) as { type?: string; summary?: string };
      if (o.type === 'summary' && o.summary) return clean(o.summary);
    } catch {
      /* skip */
    }
  }
  for (const ln of head) {
    try {
      const o = JSON.parse(ln) as { type?: string; message?: { role?: string; content?: unknown } };
      if (o.type !== 'api-request-blob' && (o.type === 'user' || o.message?.role === 'user')) {
        const t = blocksToText(o.message?.content).trim();
        if (t && !t.startsWith('[result]') && !t.startsWith('<')) return clean(t);
      }
    } catch {
      /* skip */
    }
  }
  return '';
}

/** Flatten turns to a bounded transcript string for LLM reflection input. */
export function turnsToText(turns: Turn[], maxChars = 24_000): string {
  const lines = turns.map((t) => `${t.role}: ${t.text}`);
  let s = lines.join('\n\n');
  if (s.length > maxChars) s = `…(truncated)…\n${s.slice(-maxChars)}`;
  return s;
}
