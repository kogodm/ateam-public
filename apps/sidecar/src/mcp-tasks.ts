/**
 * `ateam-tasks` — the MCP server ATeam attaches to every spawned session so an
 * agent (claude / any MCP-capable provider) can push items onto the user's
 * task list and tick them off. It writes the SAME `~/.ateam/tasks.json` the
 * desktop reads; the desktop watches the file and refreshes live.
 *
 * Launched by the session's `--mcp-config` as:
 *   node mcp-tasks.cjs --cwd <projectDir> --session <sessionId>
 * so every task an agent adds is auto-scoped to that project and session.
 *
 * Design intent baked into the tool descriptions: titles stay SHORT (that is
 * all the list shows); everything needed to actually act — paths, the command,
 * the snippet — goes in `body`, which the user's one-click send delivers to the
 * session verbatim. Keep both as terse as possible while preserving what's
 * necessary.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { addTags, addTask, completeTask, listTasks, updateTask } from '@ateam/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function argOf(flag: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? '') : '';
}

const PROJECT = argOf('--cwd');
const SESSION_ID = argOf('--session') || undefined;

/** The CREATING session's claude session id, resolved AT CALL TIME from the
 *  link file the SessionStart hook maintains (session-hook.ts) — read fresh
 *  per add_task, not once at boot, because `/clear` rotates the id mid-run.
 *  This is the durable "which conversation filed this task" pointer that the
 *  desktop's jump-to-originating-session uses; the transient --session id
 *  can't survive a restart. Best-effort: absent link file → undefined. */
function currentClaudeSessionId(): string | undefined {
  if (!SESSION_ID) return undefined;
  try {
    const home = process.env.ATEAM_HOME ?? join(homedir(), '.ateam');
    const raw = readFileSync(join(home, 'session-links', `${SESSION_ID}.json`), 'utf8');
    const j = JSON.parse(raw) as { claudeSessionId?: unknown };
    return typeof j.claudeSessionId === 'string' && j.claudeSessionId ? j.claudeSessionId : undefined;
  } catch {
    return undefined;
  }
}

/** Accept an ISO-8601 string OR epoch ms; return epoch ms, or undefined if
 *  unparseable / in the past-is-fine (we don't reject past times — a due task
 *  simply fires immediately). */
function parseRemindAt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const trimmed = v.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  const t = Date.parse(trimmed);
  return Number.isNaN(t) ? undefined : t;
}

function text(s: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: s }] };
}

/** list_tasks prints 8-char short ids to stay compact, and agents naturally
 *  echo those back into the write tools — which used to fail with "No task
 *  <shortid>" because core matches full UUIDs only. Resolve an exact id OR a
 *  unique prefix across ALL tasks (not just this project's — the agent may
 *  hold an id from another scope). Ambiguity is reported, never guessed. */
function resolveId(idOrPrefix: string): { id: string } | { err: string } {
  const q = idOrPrefix.trim();
  if (!q) return { err: 'empty id' };
  const all = listTasks({});
  if (all.some((t) => t.id === q)) return { id: q };
  const hits = all.filter((t) => t.id.startsWith(q));
  const first = hits[0];
  if (hits.length === 1 && first) return { id: first.id };
  if (hits.length > 1) {
    return { err: `Ambiguous id ${q}: matches ${hits.map((t) => t.id.slice(0, 12)).join(', ')}` };
  }
  return { err: `No task ${q}` };
}

/** Folded into the client's system prompt at connect time, so it is the only
 *  nudge that lands BEFORE the agent decides whether to touch the list at all.
 *  The list is a surface the user reads directly — a finished task still shown
 *  as `[ ]` is worse than no task — so keep this about timeliness, short
 *  enough that every spawned session can carry it. */
const INSTRUCTIONS =
  "The task list here is the user's own list — they read it live, and act on " +
  "what it says. So keep its status true as you go: the moment a task's work " +
  'lands, call complete_task; when its wording, carried context, or reminder ' +
  'time no longer matches reality, call update_task. Do not save these up for ' +
  'the end of a long run, and never leave finished work sitting open. When you ' +
  'pick work back up, call list_tasks first and tick off anything already done.';

const server = new McpServer(
  { name: 'ateam-tasks', version: '1.0.0' },
  { instructions: INSTRUCTIONS },
);

server.registerTool(
  'add_task',
  {
    title: 'Add task',
    description:
      "Add an item to the user's task list / reminders. Keep `title` SHORT — an " +
      'imperative line, no paths — because the list shows only the title. Put ' +
      'everything needed to act (file paths, the command to run, a short ' +
      'snippet) in `body`; it is hidden from the list but sent to the session ' +
      'verbatim when the user clicks send. Be terse but keep the necessary ' +
      'info. Optionally set `remindAt` for a future reminder, and up to 3 `tags`.',
    inputSchema: {
      title: z.string().min(1).describe('Short imperative title. No paths.'),
      body: z
        .string()
        .optional()
        .describe('Carried context — paths / command / snippet. Hidden in the list; sent on send.'),
      remindAt: z
        .string()
        .optional()
        .describe('Optional reminder time: ISO-8601 (e.g. 2026-08-01T09:00:00) or epoch ms.'),
      tags: z
        .array(z.string().max(24))
        .max(8)
        .optional()
        .describe(
          'Up to 3 short labels to categorize the task — e.g. a project name, ' +
            'a priority (P0 / high), or a task type (bug / feature / chore). ' +
            'Shown as colored chips. Keep each label one or two words. ' +
            'Only the first 3 are kept.',
        ),
    },
  },
  async ({ title, body, remindAt, tags }) => {
    try {
      const t = addTask({
        title,
        body,
        project: PROJECT,
        remindAt: parseRemindAt(remindAt),
        tags,
        source: 'agent',
        sessionId: SESSION_ID,
        claudeSessionId: currentClaudeSessionId(),
      });
      const when = t.remindAt ? ` (reminder ${new Date(t.remindAt).toISOString()})` : '';
      // Hand back the exact follow-up call: the id is right here, so there is
      // no excuse for leaving this one open once the work lands.
      return text(
        `Added task ${t.id}: ${t.title}${when}\nWhen this is done, complete_task ${t.id.slice(0, 8)} — don't leave it open.`,
      );
    } catch (e) {
      return { ...text(`add_task failed: ${e instanceof Error ? e.message : String(e)}`), isError: true };
    }
  },
);

server.registerTool(
  'complete_task',
  {
    title: 'Complete task',
    description:
      'Mark a task done by its id (from add_task or list_tasks). Call it as soon ' +
      'as the work lands, not batched at the end of the run — the user reads the ' +
      'list while you work.',
    inputSchema: { id: z.string().min(1).describe('Task id') },
  },
  async ({ id }) => {
    const r = resolveId(id);
    if ('err' in r) return { ...text(r.err), isError: true };
    const done = completeTask(r.id);
    return done ? text(`Completed ${r.id}`) : { ...text(`No task ${id}`), isError: true };
  },
);

server.registerTool(
  'update_task',
  {
    title: 'Update task',
    description:
      'Modify an existing task by id. Only the fields you pass change; the rest ' +
      'are left as-is. `tags` REPLACES the whole tag set (use add_tags to append). ' +
      'Set `status` to reopen/close, or `remindAt` to reschedule the reminder. ' +
      'Call it as soon as the task drifts from what it says — retitle it when the ' +
      'scope changes, refresh `body` when the paths move, reschedule rather than ' +
      'letting a stale reminder fire.',
    inputSchema: {
      id: z.string().min(1).describe('Task id'),
      title: z.string().min(1).optional().describe('New short title.'),
      body: z.string().optional().describe('New carried context (paths / command / snippet).'),
      remindAt: z
        .string()
        .optional()
        .describe('New reminder time: ISO-8601 or epoch ms. Empty string clears it.'),
      tags: z
        .array(z.string().max(24))
        .max(8)
        .optional()
        .describe('Replace tags with these (project / priority / type). First 3 kept.'),
      status: z.enum(['open', 'done']).optional().describe('Reopen (open) or complete (done).'),
    },
  },
  async ({ id, title, body, remindAt, tags, status }) => {
    const patch: {
      title?: string;
      body?: string;
      remindAt?: number | null;
      tags?: string[];
      status?: 'open' | 'done';
    } = {};
    if (title !== undefined) patch.title = title;
    if (body !== undefined) patch.body = body;
    if (remindAt !== undefined) patch.remindAt = remindAt.trim() ? parseRemindAt(remindAt) ?? null : null;
    if (tags !== undefined) patch.tags = tags;
    if (status !== undefined) patch.status = status;
    const r = resolveId(id);
    if ('err' in r) return { ...text(r.err), isError: true };
    const t = updateTask(r.id, patch);
    if (!t) return { ...text(`No task ${id}`), isError: true };
    const tg = t.tags?.length ? ` [${t.tags.join(', ')}]` : '';
    return text(`Updated ${r.id}: ${t.title}${tg} (${t.status})`);
  },
);

server.registerTool(
  'add_tags',
  {
    title: 'Add tags',
    description:
      'Append one or more labels to an existing task (project / priority / type). ' +
      'Merged with the existing tags, de-duplicated, and capped at 3 total.',
    inputSchema: {
      id: z.string().min(1).describe('Task id'),
      tags: z.array(z.string().max(24)).min(1).max(8).describe('Labels to add.'),
    },
  },
  async ({ id, tags }) => {
    const r = resolveId(id);
    if ('err' in r) return { ...text(r.err), isError: true };
    const t = addTags(r.id, tags);
    if (!t) return { ...text(`No task ${id}`), isError: true };
    return text(`Tags for ${r.id}: ${t.tags?.join(', ') ?? '(none)'}`);
  },
);

server.registerTool(
  'list_tasks',
  {
    title: 'List tasks',
    description:
      "List this project's tasks (titles + ids + status; body omitted to stay " +
      'compact). Use before adding to avoid duplicates, to find an id to ' +
      'complete, or to catch work you already finished but left marked open.',
    inputSchema: {
      status: z.enum(['open', 'done']).optional().describe('Filter by status (default: all).'),
    },
  },
  async ({ status }) => {
    const tasks = listTasks({ project: PROJECT, status });
    if (!tasks.length) return text('No tasks.');
    const lines = tasks.map((t) => {
      const mark = t.status === 'done' ? '[x]' : '[ ]';
      const rem = t.remindAt ? ` ⏰${new Date(t.remindAt).toISOString().slice(0, 16)}` : '';
      const tg = t.tags?.length ? ` ${t.tags.map((x) => `#${x}`).join(' ')}` : '';
      return `${mark} ${t.id.slice(0, 8)}  ${t.title}${tg}${rem}`;
    });
    // Nudge where it is cheapest to act on: the open ids are right above.
    const open = tasks.filter((t) => t.status === 'open').length;
    if (open) {
      lines.push(
        '',
        `${open} still open. Any of them already finished? complete_task it now; if one has drifted, update_task it.`,
      );
    }
    return text(lines.join('\n'));
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch((e) => {
  process.stderr.write(`ateam-tasks MCP failed to start: ${String(e)}\n`);
  process.exit(1);
});
