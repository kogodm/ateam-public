import type { Turn, TurnRole } from '@ateam/contract';
import { peerToolName } from '../peer-tools';
import { toolInputSummary } from '../transcript-file';
import { codexCommandLabel, codexEventItem } from './codex-events';
import { codexPatch } from './codex-patch';

/**
 * Codex rollout jsonl → the same Turn blocks the stream renders for Claude.
 *
 * The two formats have nothing in common. A Claude record is a message with a
 * role and content blocks; a codex rollout line is `{timestamp, type, payload}`
 * where the interesting types are `response_item` (the raw model exchange) and
 * `event_msg` (what the harness announced). Running the Claude parser over a
 * codex file produces exactly zero turns, which is why a codex session read as
 * empty in the stream while the terminal — which shows raw PTY output — looked
 * fine. Measured: a 6787-line rollout, 0 blocks.
 *
 * Text uses visual events; tools may also exist only in response_item.
 */

interface Line {
  timestamp?: string;
  type?: string;
  payload?: {
    [key: string]: unknown;
    type?: string;
    item?: Record<string, unknown>;
    message?: unknown;
    /** task_complete: set when the turn failed */
    error?: { message?: unknown };
    /** turn_aborted */
    reason?: unknown;
    call_id?: unknown;
    name?: unknown;
    arguments?: unknown;
    input?: unknown;
    output?: unknown;
    changes?: unknown;
    success?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
}

export interface CodexProjectionOptions {
  toolSource?: 'event_msg' | 'response_item';
  responseCallIds?: ReadonlySet<string>;
  responseOutputIds?: ReadonlySet<string>;
}

export function codexResponseOutputIds(lines: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Line;
      if (
        record.type === 'response_item' &&
        ['function_call_output', 'custom_tool_call_output'].includes(record.payload?.type ?? '') &&
        typeof record.payload?.call_id === 'string'
      )
        ids.add(record.payload.call_id);
    } catch {}
  }
  return ids;
}

export function codexResponseCallIds(lines: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Line;
      if (
        record.type === 'response_item' &&
        [
          'function_call',
          'custom_tool_call',
          'function_call_output',
          'custom_tool_call_output',
        ].includes(record.payload?.type ?? '') &&
        typeof record.payload?.call_id === 'string'
      )
        ids.add(record.payload.call_id);
    } catch {}
  }
  return ids;
}

export function codexToolSource(lines: readonly string[]): CodexProjectionOptions['toolSource'] {
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as Line;
      if (
        rec.type === 'response_item' &&
        [
          'function_call',
          'custom_tool_call',
          'function_call_output',
          'custom_tool_call_output',
        ].includes(rec.payload?.type ?? '')
      )
        return 'response_item';
    } catch {}
  }
  return 'event_msg';
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Codex ImageView paths are often `file:///…` URIs; Stream needs a real path
 *  to open/preview the picture (same as the TUI's "Viewed image" row). */
export function codexLocalPath(raw: string): string {
  const s = raw.trim();
  if (!/^file:\/\//i.test(s)) return s;
  let p = s.replace(/^file:\/\//i, '').replace(/[?#].*$/, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as written */
  }
  return p;
}

/** codex content parts are `{type:'text'|'Text', text}` with other kinds
 *  (images, encrypted blobs) mixed in — take the text, ignore the rest. */
function partsText(v: unknown): string {
  if (!Array.isArray(v)) return '';
  const out: string[] = [];
  for (const p of v) {
    if (typeof p === 'string') {
      out.push(p);
      continue;
    }
    if (p && typeof p === 'object') {
      const t = (p as { text?: unknown }).text;
      if (typeof t === 'string' && t) out.push(t);
    }
  }
  return out.join('\n');
}

/** A command is `["/bin/zsh","-lc","<the real command>"]` — the shell wrapper
 *  is noise on a phone; show what was actually run. */
export function commandText(v: unknown): string {
  if (!Array.isArray(v)) return str(v);
  const parts = v.filter((x): x is string => typeof x === 'string');
  const lc = parts.indexOf('-lc');
  if (lc >= 0 && parts[lc + 1]) return parts[lc + 1] as string;
  const c = parts.indexOf('-c');
  if (c >= 0 && parts[c + 1]) return parts[c + 1] as string;
  return parts.join(' ');
}

/** Cap any single block. A build log or a whole file's contents can be
 *  megabytes, and every byte of it would be shipped to a phone. */
const CAP = 8000;
const cap = (s: string): string => (s.length > CAP ? `${s.slice(0, CAP)}\n… (truncated)` : s);

/** An API error arrives as its raw JSON body — `{"type":"error","status":400,
 *  "error":{"message":"…"}}`. Show the status and the message, not the JSON. */
function errorText(raw: string): string {
  try {
    const o = JSON.parse(raw) as { status?: unknown; error?: { message?: unknown } };
    const m = str(o.error?.message);
    if (m) return typeof o.status === 'number' ? `${o.status} · ${m}` : m;
  } catch {
    /* plain text already */
  }
  return raw;
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(outputText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const part = value as Record<string, unknown>;
    if (['image', 'input_image', 'image_url'].includes(str(part.type))) return '[Image]';
    if (typeof part.text === 'string') return part.text;
    if ('content' in part) return outputText(part.content);
  }
  return JSON.stringify(value);
}

function responseTool(rec: Line, sessionId: string, nextSeq: number): Turn[] {
  const payload = rec.payload;
  if (!payload) return [];
  const type = payload.type;
  if (
    ![
      'function_call',
      'custom_tool_call',
      'function_call_output',
      'custom_tool_call_output',
    ].includes(type ?? '')
  )
    return [];
  const id = str(payload.call_id);
  if (!id) return [];
  const result = type?.endsWith('_output');
  let name = str(payload.name);
  let text = '';
  let peer: ReturnType<typeof peerToolName>;
  if (result) {
    text = outputText(payload.output).trim() || '[completed]';
  } else if (type === 'custom_tool_call') {
    text = str(payload.input) || name;
    if (name.split('.').at(-1) === 'apply_patch') name = 'Edit';
  } else {
    const raw = str(payload.arguments);
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        args = parsed as Record<string, unknown>;
    } catch {}
    peer = peerToolName(name);
    if (peer) {
      name = peer;
      text = toolInputSummary(args);
    } else
      switch (name.split('.').at(-1)) {
        case 'exec_command':
          name = 'Bash';
          text = commandText(args.cmd) || raw;
          break;
        case 'view_image':
          text = str(args.path) || raw;
          break;
        case 'send_input':
          text = `Sent input to ${str(args.id)}\n${str(args.message)}`;
          break;
        case 'wait':
          text = Array.isArray(args.ids)
            ? `Waiting for ${args.ids.filter((id) => typeof id === 'string').join(', ')}`
            : raw;
          break;
        default:
          text = raw;
      }
    if (!peer) text ||= name;
  }
  return [
    {
      seq: nextSeq,
      sessionId,
      role: result || peer ? 'tool' : 'assistant',
      kind: result ? 'tool_result' : 'tool_use',
      text: cap(text.trim()),
      at: rec.timestamp ?? '',
      toolUseId: id,
      ...(!result ? { toolName: name } : {}),
    },
  ];
}

export function parseCodexBlocks(
  line: string,
  sessionId: string,
  nextSeq: number,
  options: CodexProjectionOptions = {},
): Turn[] {
  const raw = line.trim();
  if (!raw || raw[0] !== '{') return [];
  let rec: Line;
  try {
    rec = JSON.parse(raw) as Line;
  } catch {
    return []; // a half-written tail line; the next read will have it whole
  }
  if (rec.type === 'response_item') {
    return options.toolSource === 'event_msg' ? [] : responseTool(rec, sessionId, nextSeq);
  }
  if (rec.type !== 'event_msg') return [];
  if (rec.payload?.type === 'patch_apply_end') {
    const payload = rec.payload;
    const callId = str(payload.call_id);
    if (!callId) return [];
    const patch = payload.success === true ? codexPatch(payload.changes) : [];
    const label =
      payload.success === true
        ? `Edited ${patch.length} ${patch.length === 1 ? 'file' : 'files'}`
        : 'File edit failed';
    const common = { sessionId, at: rec.timestamp ?? '', toolUseId: `codex-patch:${callId}` };
    return [
      {
        ...common,
        seq: nextSeq,
        role: 'assistant',
        kind: 'tool_use',
        toolName: 'Edit',
        label,
        text: cap(patch.map((file) => file.file).join('\n')) || label,
      },
      {
        ...common,
        seq: nextSeq + 1,
        role: 'tool',
        kind: 'tool_result',
        text: cap([str(payload.stdout), str(payload.stderr)].filter(Boolean).join('\n')) || label,
        ...(patch.length ? { patch } : {}),
      },
    ];
  }
  if (rec.payload?.type === 'user_message' || rec.payload?.type === 'agent_message') {
    const images = [rec.payload.images, rec.payload.local_images].some(
      (value) => Array.isArray(value) && value.length > 0,
    );
    const message = str(rec.payload.message).trim() || (images ? '[Image attached]' : '');
    return message
      ? [
          {
            seq: nextSeq,
            sessionId,
            role: rec.payload.type === 'user_message' ? 'user' : 'assistant',
            text: cap(message),
            at: rec.timestamp ?? '',
            kind: 'text',
          },
        ]
      : [];
  }
  // A failed turn leaves no item — only its task_complete carries the error
  // (the 400 for an unsupported model, "You've hit your usage limit"). The
  // terminal prints it in red; without this the stream view just went quiet.
  if (rec.payload?.type === 'task_complete' || rec.payload?.type === 'turn_complete') {
    const msg = str(rec.payload.error?.message);
    return msg
      ? [
          {
            seq: nextSeq,
            sessionId,
            role: 'assistant',
            text: cap(errorText(msg)),
            at: rec.timestamp ?? '',
            kind: 'text',
            notice: 'error',
          },
        ]
      : [];
  }
  if (rec.payload?.type === 'turn_aborted') {
    const why = str(rec.payload.reason);
    return [
      {
        seq: nextSeq,
        sessionId,
        role: 'assistant',
        text: why === 'interrupted' ? 'Interrupted' : `Turn aborted${why ? ` (${why})` : ''}`,
        at: rec.timestamp ?? '',
        kind: 'text',
        notice: 'info',
      },
    ];
  }
  const item =
    rec.payload?.type === 'item_completed'
      ? rec.payload.item
      : rec.payload
        ? codexEventItem(rec.payload)
        : undefined;
  if (!item) return [];
  if (
    (options.responseCallIds
      ? options.responseCallIds.has(str(item.id))
      : options.toolSource === 'response_item') &&
    [
      'CommandExecution',
      'McpToolCall',
      'Extension',
      'CollabAgentToolCall',
      'ImageView',
      'DynamicToolCall',
    ].includes(str(item.type))
  )
    return [];
  const at = rec.timestamp ?? '';
  const out: Turn[] = [];
  let seq = nextSeq;
  const push = (role: TurnRole, text: string, kind?: Turn['kind'], toolName?: string): void => {
    const t = text.trim();
    if (!t) return;
    out.push({
      seq: seq++,
      sessionId,
      role,
      text: cap(t),
      at,
      kind,
      toolName,
      ...((kind === 'tool_use' || kind === 'tool_result') && str(item.id)
        ? { toolUseId: item.type === 'FileChange' ? `codex-patch:${str(item.id)}` : str(item.id) }
        : {}),
    });
  };

  switch (str(item.type)) {
    case 'UserMessage':
      push(
        'user',
        partsText(item.content) ||
          (Array.isArray(item.content) && item.content.length ? '[Attachment]' : ''),
        'text',
      );
      break;
    case 'AgentMessage':
      push('assistant', partsText(item.content), 'text');
      break;
    case 'Reasoning': {
      // summary_text is usually empty and raw_content encrypted — there is
      // genuinely nothing to show then, and an empty "thinking" block is worse
      // than none.
      const text = partsText(item.summary_text) || partsText(item.raw_content);
      push('assistant', text, 'thinking');
      break;
    }
    case 'CommandExecution': {
      push('assistant', commandText(item.command), 'tool_use', 'Bash');
      const label = codexCommandLabel(item.parsed_cmd);
      if (out[0] && label) out[0] = { ...out[0], label };
      const code = item.exit_code;
      const body =
        str(item.aggregated_output) ||
        [str(item.stdout), str(item.stderr)].filter(Boolean).join('\n');
      const head =
        typeof code === 'number' && code !== 0
          ? `[exit ${code}]\n`
          : ['failed', 'declined'].includes(str(item.status))
            ? `[${str(item.status)}]\n`
            : '';
      push(
        'tool',
        head + body || (typeof code === 'number' ? `[exit ${code}]` : str(item.status)),
        'tool_result',
      );
      break;
    }
    case 'FileChange': {
      const patch = item.status === 'completed' ? codexPatch(item.changes) : [];
      const label = patch.length
        ? `Edited ${patch.length} files`
        : `File changes: ${str(item.status) || 'unknown status'}`;
      push('assistant', patch.map((file) => file.file).join('\n') || label, 'tool_use', 'Edit');
      if (out[0]) out[0] = { ...out[0], label };
      push(
        'tool',
        [str(item.stdout), str(item.stderr)].filter(Boolean).join('\n') || label,
        'tool_result',
      );
      if (out[1] && patch.length) out[1] = { ...out[1], patch };
      break;
    }
    case 'McpToolCall': {
      const label = `${str(item.server)}.${str(item.tool)}`;
      const peer = peerToolName(`mcp__${str(item.server)}__${str(item.tool)}`);
      if (peer) {
        const input = item.arguments ?? {};
        const desc = (input as { description?: unknown }).description;
        // ListAgents has empty text; unlike other Codex tools it still needs a call turn.
        out.push({
          seq: seq++,
          sessionId,
          at,
          role: 'tool',
          kind: 'tool_use',
          toolName: peer,
          text: toolInputSummary(input),
          ...(typeof desc === 'string' && desc.trim() ? { label: desc.trim().slice(0, 120) } : {}),
        });
      } else
        push(
          'assistant',
          `${label}\n${JSON.stringify(item.arguments ?? {}, null, 2)}`,
          'tool_use',
          label,
        );
      push(
        'tool',
        (item.error ? `Error: ${outputText(item.error)}` : outputText(item.result)) ||
          str(item.status) ||
          '[completed]',
        'tool_result',
      );
      break;
    }
    case 'FunctionCallOutput':
      if (!options.responseOutputIds?.has(str(item.id)))
        push('tool', outputText(item.output) || '[completed]', 'tool_result', str(item.name));
      break;
    case 'Plan':
      push('assistant', str(item.text), 'text');
      break;
    case 'DynamicToolCall':
      push('assistant', JSON.stringify(item.arguments ?? {}), 'tool_use', str(item.tool));
      push(
        'tool',
        str(item.error) || outputText(item.content_items) || str(item.status) || '[completed]',
        'tool_result',
      );
      break;
    case 'WebSearch':
      push(
        'assistant',
        str(item.query) || outputText(item.action) || 'Web search',
        'tool_use',
        'WebSearch',
      );
      push('tool', outputText(item.results) || '[Search completed]', 'tool_result');
      break;
    case 'ImageGeneration':
      push(
        'assistant',
        str(item.revised_prompt) || 'Generate image',
        'tool_use',
        'ImageGeneration',
      );
      push(
        'tool',
        outputText(item.failure) ||
          str(item.saved_path) ||
          str(item.status) ||
          '[Image generation completed]',
        'tool_result',
      );
      break;
    case 'Extension': {
      const kind = str(item.kind);
      push(
        'assistant',
        str(item.query) ||
          (kind === 'clock.sleep' ? `Wait ${Number(item.durationMs) || 0} ms` : kind),
        'tool_use',
        kind || 'extension',
      );
      push(
        'tool',
        kind === 'web.search'
          ? outputText(item.results) || '[Search completed]'
          : str(item.status) || '[completed]',
        'tool_result',
      );
      break;
    }
    case 'ImageView':
      // Match Codex TUI "Viewed image <basename>" — path must be local so
      // Stream can thumb + open it (file:// URIs never matched imagePaths).
      push('assistant', codexLocalPath(str(item.path)), 'tool_use', 'view_image');
      push('tool', '[completed]', 'tool_result');
      break;
    case 'SubAgentActivity':
      push(
        'assistant',
        `Agent ${str(item.agent_path) || str(item.agent_thread_id)} ${str(item.kind)}`,
        'text',
      );
      if (out[0]) out[0] = { ...out[0], notice: 'info' };
      break;
    case 'CollabAgentToolCall': {
      const ids = Array.isArray(item.receiver_thread_ids)
        ? item.receiver_thread_ids.filter((id): id is string => typeof id === 'string')
        : [];
      push(
        'assistant',
        str(item.prompt) || `${str(item.tool)} ${ids.join(', ')}`,
        'tool_use',
        str(item.tool) === 'spawn_agent' ? 'Agent' : str(item.tool),
      );
      const states =
        item.agents_states && typeof item.agents_states === 'object'
          ? (item.agents_states as Record<string, unknown>)
          : {};
      push(
        'tool',
        ids
          .map((id) => `agentId: ${id}\n${JSON.stringify(states[id] ?? item.status ?? '')}`)
          .join('\n') || str(item.status),
        'tool_result',
      );
      break;
    }
    case 'ContextCompaction':
      push('assistant', 'Context compacted', 'text');
      if (out[0]) out[0] = { ...out[0], notice: 'info' };
      break;
    case 'EnteredReviewMode':
    case 'ExitedReviewMode':
      push(
        'assistant',
        str(item.user_facing_hint) ||
          outputText(item.review_output) ||
          (item.type === 'EnteredReviewMode' ? 'Review started' : 'Review completed'),
        'text',
      );
      if (out[0]) out[0] = { ...out[0], notice: 'info' };
      break;
    default:
      break;
  }
  return out;
}
