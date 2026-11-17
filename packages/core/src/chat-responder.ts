import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Chat, ChatMessage } from './chat';
import type { FloorTrigger } from './chat-floor';
import { ateamHome } from './paths';
import { loginShellEnv } from './platform';
import { resolveClaudeBin } from './session/claude-bin';
import { claudeSettingsEnv, stripClaudeProcessMarkers } from './session/claude-env';
import { logUsage } from './usage-log';

/**
 * The chat-side self of a teammate.
 *
 * A teammate in chat mode is ONE Human wearing two sessions:
 *   • the WORK session — long-running, hidden, does the actual job and
 *     carries a huge context (the code, the tool output, the sub-agents);
 *   • the CHAT session — this file: a one-shot `claude -p` that only talks.
 * The user's message is never pushed into the work session. Instead, when it
 * is this teammate's turn to speak (see chat-floor.ts), we run a short
 * responder as the same Human — same name, role and knowledge index (meta.md)
 * — with just the conversation as context. It answers in the chat and, when
 * the message needs real work, hands a precise task to the work session.
 * That keeps the chat from paying the work session's context on every reply
 * (the "token explosion" the user asked to avoid) while still speaking with
 * the teammate's own background.
 *
 * The one-shot is deliberately spartan: no user MCP servers, no settings /
 * CLAUDE.md, only Read/Glob/Grep so it can consult its knowledge files, a
 * hard turn cap and a wall-clock timeout. Measured cost: a few hundred input
 * tokens plus the transcript, versus ~28k with the defaults.
 */

export interface ResponderReply {
  /** what to post in the chat; empty = nothing to add */
  say: string;
  /** a task for the work session; empty = no work needed */
  work: string;
}

export interface ResponderInput {
  chat: Pick<Chat, 'id' | 'name' | 'purpose' | 'workdir' | 'kind'>;
  who: { id: string; name: string; role: string };
  /** the other teammates, in roster order */
  peers: { id: string; name: string; role: string }[];
  /** first in the roster — proposes the split on a new task */
  isLead: boolean;
  /** teammates who already had their turn on this message (spoke or passed) */
  spokeBefore: string[];
  /** what opened this turn: the user posted, or a teammate delivered a result */
  trigger: FloorTrigger;
  /** the human's recall text (knowledge index), '' when none */
  recall: string;
  /** what the work session is doing right now */
  workState: 'none' | 'idle' | 'busy';
  /** the conversation so far, oldest → newest (the last is the user's message
   *  unless a teammate replied since) */
  transcript: ChatMessage[];
  /** absolute cwd for the one-shot (the chat's workdir or the desk) */
  cwd: string;
}

/** most of the transcript fed to the responder, in characters */
const TRANSCRIPT_BUDGET = 8000;
/** the one-shot must answer within this, else it counts as a pass */
const RESPONDER_TIMEOUT_MS = 120_000;
/** the responder may consult its knowledge files, but not wander */
const MAX_TURNS = 4;

/** Render the conversation for the prompt, newest-biased under the budget. */
export function renderTranscript(
  msgs: ChatMessage[],
  selfId: string,
  names: (id: string) => string,
  budget = TRANSCRIPT_BUDGET,
): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    const who = m.from === 'user' ? 'user' : m.from === selfId ? 'you' : names(m.from);
    const att = m.attachments?.length
      ? ` (attached: ${m.attachments.map((a) => a.name).join(', ')})`
      : '';
    const tag = m.kind === 'status' ? ' [status]' : m.kind === 'result' ? ' [result]' : '';
    const line = `[${who}]${tag} ${m.text}${att}`;
    if (used + line.length > budget && lines.length > 0) break;
    lines.push(line);
    used += line.length;
  }
  return lines.reverse().join('\n');
}

/** The replacement system prompt for the one-shot (NOT appended to Claude
 *  Code's default one — that alone is ~28k tokens we don't want per reply). */
export function responderSystemPrompt(input: ResponderInput): string {
  const { chat, who, peers, isLead } = input;
  const scope = chat.purpose ? ` The chat is for: ${chat.purpose}.` : '';
  const where = chat.workdir
    ? `Its working directory is ${chat.workdir}.`
    : 'It has no fixed project directory.';
  const lines = [
    `You are ${who.name}, a ${who.role} on this team, talking with the user in the chat "${chat.name}".${scope}`,
    'You are the CHAT side of yourself: a short session that only talks. Your WORK side is a separate long-running session of you that does the actual work; it takes tasks from you and posts its own milestones and results into this chat.',
    where,
    `Your work side right now: ${input.workState === 'busy' ? 'busy on a task' : input.workState === 'idle' ? 'idle' : 'not started yet'}.`,
    '',
    'Answer with ONLY a JSON object, no prose around it: {"say": string, "work": string}',
    '- "say": one or two sentences to post in the chat, in the language the user writes in. Empty string when there is nothing to add — never acknowledge for its own sake, never repeat what a teammate already said about THEIR part.',
    '- When the user asks the group a question — progress, status, who did what, an opinion — ALWAYS answer for yourself in "say", one line, even if your answer is "no change since last time". Silence is only for messages that do not concern you at all.',
    '- "work": empty string, or a precise instruction to your work side when the user\'s message needs real work from you (build, fix, investigate, verify, produce a document, report something only the code/files can tell). Include what, where, and what done looks like. Never assign work that is already done, already in progress, or that belongs to a teammate.',
    '- A status question you cannot answer from the conversation: say what you know, and put "report <what> in the chat" in "work" so your work side fills in the rest.',
    '- Do not paste code or long output; documents are delivered by the work side as links.',
    '- If the answer really needs several points, write one short line then at most 4 bullet lines starting with "- ", one fact each, under ~12 words. Never a dense paragraph.',
    '- If your part can only start after a teammate finishes theirs, leave "work" empty — you will be asked again the moment their result lands. Never hand your work side a "wait for X" task.',
  ];
  if (input.trigger === 'peer-result') {
    lines.push(
      '',
      "This turn was opened because a teammate's work side just delivered a result (the last [result] line). Speak or hand out work ONLY if that result unblocks your part or the user must know something now; otherwise reply with empty strings.",
    );
  }
  if (peers.length > 0) {
    const roster = peers.map((p) => `${p.name} (${p.role})`).join(', ');
    lines.push(
      '',
      `This is a GROUP. Teammates: ${roster}. The user's message is handed to teammates one at a time in roster order, the lead first; the ones before you have already answered (see the conversation).`,
    );
    if (isLead) {
      lines.push(
        'You are the LEAD. When the user brings a new task, propose the split in "say": name who takes which part, divided by role or module so the job is covered exactly once — never have two people build the same thing. Put your own part in "work". When the user only asks a question, just answer it.',
      );
    } else {
      const lead = peers[0];
      lines.push(
        `${lead ? lead.name : 'The lead'} proposes the split. Take only the part assigned to you (put it in "work"); confirm it in "say" only if that adds information (a caveat, an ETA, something missing). If no part was given to you and nothing is missing, reply with empty strings.`,
      );
    }
  }
  if (input.recall) lines.push('', input.recall);
  lines.push('', 'Be brief and concrete, like a busy colleague.');
  return lines.join('\n');
}

function pickJsonObject(s: string): Record<string, unknown> | null {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1)) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Failures are swallowed as a pass so the chat never wedges — but a silent
 *  pass is undiagnosable, so every one is logged here with the CLI's stderr
 *  and its result envelope (`~/.ateam/chat-responder.log`). */
export function responderLogPath(): string {
  return join(ateamHome(), 'chat-responder.log');
}
function logFailure(who: string, why: string, stderr: string, envelope: string): void {
  try {
    mkdirSync(ateamHome(), { recursive: true });
    appendFileSync(
      responderLogPath(),
      `${new Date().toISOString()} ${who}: ${why}\n  stderr: ${stderr.trim().slice(-1500)}\n  envelope: ${envelope.trim().slice(0, 1500)}\n`,
    );
  } catch {
    /* logging is best-effort */
  }
}

/** Run the one-shot. Resolves to null on any failure (treated as a pass —
 *  the chat must never wedge on a teammate that could not answer). */
export async function runChatResponder(
  input: ResponderInput,
  names: (id: string) => string,
): Promise<ResponderReply | null> {
  // First try skips the user's settings files (smallest prompt); if the API
  // refuses — auth or routing that only the settings provide (apiKeyHelper,
  // an env we did not think of) — try once more with them.
  const first = await runOnce(input, names, '');
  if (first.reply || first.reason !== 'api_error') return first.reply;
  return (await runOnce(input, names, 'user')).reply;
}

function runOnce(
  input: ResponderInput,
  names: (id: string) => string,
  settingSources: '' | 'user',
): Promise<{ reply: ResponderReply | null; reason?: string }> {
  const system = responderSystemPrompt(input);
  const convo = renderTranscript(input.transcript, input.who.id, names);
  const user = [
    'The conversation so far (oldest first):',
    convo || '(empty)',
    '',
    'Now answer with the JSON object.',
  ].join('\n');
  const args = [
    '-p',
    '--output-format',
    'json',
    '--max-turns',
    String(MAX_TURNS),
    '--tools',
    'Read,Glob,Grep',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    settingSources,
    '--system-prompt',
    system,
  ];
  return new Promise<{ reply: ResponderReply | null; reason?: string }>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveClaudeBin(), args, {
        cwd: input.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // same env recipe as the PTY sessions: a GUI-launched app lacks the
        // login shell's API endpoint / proxy / PATH, and a nested-claude
        // marker would make the one-shot refuse to start
        // The settings.json env block (proxy / endpoint) is what the
        // interactive CLI would apply itself; with settings skipped we must.
        env: stripClaudeProcessMarkers({
          ...loginShellEnv(),
          ...claudeSettingsEnv(),
          ...process.env,
        }),
      });
    } catch (e) {
      logFailure(input.who.name, `spawn failed: ${String(e)}`, '', '');
      resolve({ reply: null, reason: 'spawn' });
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (v: ResponderReply | null, reason?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ reply: v, reason });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      logFailure(input.who.name, `timeout after ${RESPONDER_TIMEOUT_MS}ms`, err, out);
      finish(null, 'timeout');
    }, RESPONDER_TIMEOUT_MS);
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      err += String(d);
    });
    child.on('error', (e) => {
      logFailure(input.who.name, `spawn error: ${String(e)}`, err, out);
      finish(null, 'spawn');
    });
    child.on('close', (code) => {
      const env = pickJsonObject(out);
      const u = (env?.usage ?? {}) as Record<string, unknown>;
      logUsage({
        op: 'chat',
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheCreationTokens: num(u.cache_creation_input_tokens),
        costUsd: num(env?.total_cost_usd),
        detail: `${input.who.name}@${input.chat.name}`,
        chatId: input.chat.id,
      });
      const result = typeof env?.result === 'string' ? env.result : out;
      const o = pickJsonObject(result);
      if (!o) {
        const reason =
          typeof env?.terminal_reason === 'string' && env.terminal_reason !== 'completed'
            ? env.terminal_reason
            : `no JSON reply (exit ${code})`;
        logFailure(input.who.name, `${reason} (settings: ${settingSources || 'none'})`, err, out);
        finish(null, reason);
        return;
      }
      // the transcript shows teammates' notes as "[status] …"; a reply that
      // copies the tag would render it literally
      const say =
        typeof o.say === 'string' ? o.say.trim().replace(/^\[(status|result)\]\s*/i, '') : '';
      const work = typeof o.work === 'string' ? o.work.trim() : '';
      finish({ say, work });
    });
    try {
      child.stdin?.end(user);
    } catch {
      finish(null);
    }
  });
}
