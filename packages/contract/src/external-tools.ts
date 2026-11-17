/**
 * The external MCP tool list as plain JSON schema, shared by the local stdio
 * connector (mcp-desktop) and the relay gateway (which adds `machine_id`). The
 * sidecar's own server validates the same names with zod; a test keeps them equal.
 * No imports: the relay bundles this file on its own.
 */
export interface ExternalToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  annotations?: Record<string, boolean>;
}

/**
 * How a client should work with Ateam's sessions — sent as the MCP server
 * instructions by every entry point (local server, stdio connector, relay).
 */
export const EXTERNAL_INSTRUCTIONS = [
  'On EVERY new Ateam-related chat, actively call list_sessions and list_projects to recover the real sessions and approved projects. Never assume you remember project context, and never claim a session or project is unavailable without trying the relevant tool. For the chosen Human, read its memory with read_session_memory; if a prior task may exist, use list_conversations to find and resume it.',
  'You are the coordinator: own product judgment, solution scope and acceptance. Existing CLI sessions are bounded implementation workers; give them concrete tasks and do not delegate product decisions or open-ended architecture choices.',
  'Adapt task difficulty from observed outcomes, not model name alone. Start with bounded work. If the same worker returns repeated errors, misses specifications or needs multiple corrections, split the work into tiny single-file tests or mechanical edits. Reserve multi-file architecture and difficult debugging for a stronger worker when available. Independently verify diffs and tests, and increase difficulty only after successful work.',
  'Never treat a worker\'s answer as proof of completion; inspect the result and verify the relevant behavior yourself.',
  'Ateam connects you to the user\'s approved projects and to their existing, real CLI sessions (Claude Code, Codex). Each session is a live coding agent with its own model, context and history.',
  'MCP direct-first: when an available Ateam tool and its granted capabilities let you complete the task, do it directly with MCP. Use list_projects, get_project_context, search_code, read_file, get_git_status, get_git_diff, run_command and get_command_result for project inspection, queries, logs, service checks, tests, builds and permitted commands. Follow the user\'s intent for authorized git_commit and git_push. Do not ask a busy CLI session to do simple work you can do directly. Before acting, read applicable project and Human skills, schemas and safety rules. Database writes require a dry run and explicit authorization; production actions require stricter confirmation.',
  'Delegate only complex code implementation or work that needs a persistent coding agent, using send_message to the session the user specified. During recovery, identify that session from context and list_sessions; never guess, choose a different session by speed/model, or create/switch sessions without first telling the user and waiting for their decision. The chosen session remains the implementation worker while you coordinate decisions and acceptance. If it supports same-model subagents, it may parallelize within that session rather than routing work across sessions.',
  'Write each message as one bounded task: goal, files or scope, constraints, acceptance criteria, and what to report back. Send only what the session does not already know.',
  'Conversation continuity: a session remembers everything said in it. Follow up in the same conversation by passing its conversation_id, refer back to earlier turns rather than repeating background, and keep one conversation per line of work. After reconnecting or in a new chat, recover with list_conversations and continue reading from the cursor you saved. Session ids survive Ateam restarts; if a session is unavailable (it was cleared, handed off or closed), call list_sessions again and tell the user.',
  'After send_message, wait for the result yourself: poll get_messages from your saved next_cursor until a message whose in_reply_to equals your message_id arrives. Poll patiently with growing intervals (about 10 s, then 20 s, 30 s, then every minute) and keep the user informed while you wait. Do not resend the task; reuse the same idempotency_key only to retry a failed call.',
  'When direct run_command, git_commit or git_push work belongs to a user-specified connected session and its session_id or conversation_id is reliable, pass the association so Ateam can show the command activity there. If no reliable association is available, do not guess or block an otherwise authorized MCP task just for visibility; ask only when the user explicitly requires session association. Do not switch to send_message just for visibility. Linking affects display only: commands still execute independently and never enter the CLI PTY or change the execution target or permissions.',
  'These are global MCP rules across all Humans. Human skills, knowledge and experiences describe only that Human\'s project context. On a Human switch, retain these global rules but do not assume access to another Human\'s private memory; read the chosen Human\'s memory explicitly.',
  'A reply means the session answered, not that the work is correct: check the result yourself (get_git_diff, read_file) before telling the user it is done, and send a precise follow-up in the same conversation if something is missing.',
  'Memory: every session works as a Human (list_sessions shows it) whose skills, knowledge and experiences grow over time. Before planning work for a session, read its memory with read_session_memory (the index, then only the entries that matter). After a task is verified, record what was learned with record_memory on the session that did the work: an experience (what happened, what was done, outcome, lesson, when it applies) or knowledge (facts about the project worth keeping). Keep entries short and specific; your reasoning is otherwise lost when this chat ends, and the next chat reads it from there.',
].join('\n\n');

const text = { type: 'string' };
const cursor = { type: 'integer', minimum: 0, default: 0 };
const project = { type: 'string', description: 'project_id from list_projects or list_sessions' };
const runSession = {
  type: 'string',
  description: 'Exact session_id from list_sessions to associate this execution with',
};
const runConversation = {
  type: 'string',
  format: 'uuid',
  description: 'Existing conversation_id from this client to associate this execution with',
};
const readOnly = { readOnlyHint: true };

export const EXTERNAL_TOOLS: ExternalToolDef[] = [
  {
    name: 'list_projects',
    description:
      'List projects the user approved for this client (project_id, name, root). On every new Ateam chat, rediscover approved projects and call list_sessions; never assume prior context. Start here to read code without involving any CLI session.',
    inputSchema: { type: 'object', properties: {} },
    annotations: readOnly,
  },
  {
    name: 'get_project_context',
    description:
      'Compact overview of one project: stack, top-level entries, docs, .ai/ planning files and git state.',
    inputSchema: { type: 'object', properties: { project_id: project }, required: ['project_id'] },
    annotations: readOnly,
  },
  {
    name: 'search_code',
    description:
      'Search project files (case-insensitive text, or regex=true). Returns path, line and a short snippet, paged with cursor. Sensitive files are never searched.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: project,
        query: text,
        regex: { type: 'boolean', default: false },
        path_prefix: { type: 'string', description: 'directory relative to the project root' },
        glob: { type: 'string', description: 'gitignore-style filter, e.g. *.ts or src/**/*.cs' },
        max_results: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
        cursor,
      },
      required: ['project_id', 'query'],
    },
    annotations: readOnly,
  },
  {
    name: 'read_file',
    description:
      'Read a text file with line numbers (up to 400 lines / 64 KB per call; continue with next_start_line). A directory path returns its listing. Binary and sensitive files are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: project,
        path: { type: 'string', description: 'relative to the project root; "" for the root' },
        start_line: { type: 'integer', minimum: 1, default: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      required: ['project_id', 'path'],
    },
    annotations: readOnly,
  },
  {
    name: 'get_git_status',
    description: 'Branch, HEAD, ahead/behind and changed files of a project.',
    inputSchema: { type: 'object', properties: { project_id: project }, required: ['project_id'] },
    annotations: readOnly,
  },
  {
    name: 'get_git_diff',
    description:
      'Paged diff (20 files / 64 KB per page). Default: working tree vs index; staged=true: index vs HEAD; base_ref (and head_ref) compare commits or a commit with the working tree.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: project,
        base_ref: text,
        head_ref: text,
        staged: { type: 'boolean', default: false },
        path_prefix: text,
        cursor,
      },
      required: ['project_id'],
    },
    annotations: readOnly,
  },
  {
    name: 'request_project_access',
    description:
      'Ask the user, in Ateam, to grant a project folder and optional capabilities (execute = run_command, git_commit, git_push, create_session). Read access comes with any granted project. Once approved, a capability is used without further prompts. Returns a request_id; check it with list_pending_authorizations.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'project folder: absolute, ~/..., or relative to the home folder' },
        capabilities: {
          type: 'array',
          items: { type: 'string', enum: ['execute', 'git_commit', 'git_push', 'create_session'] },
          default: [],
        },
        reason: { type: 'string', description: 'one sentence shown to the user' },
      },
      required: ['path', 'reason'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'list_pending_authorizations',
    description:
      'Your project access requests (pending, approved, denied, expired) and the projects and capabilities you hold now.',
    inputSchema: { type: 'object', properties: {} },
    annotations: readOnly,
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in a project granted the execute capability (login shell, project root as cwd). Optionally pass session_id or conversation_id to associate the execution with an existing session; this does not send input to its CLI. Answers within ~10 s when it can; otherwise returns status running and an execution_id for get_command_result. Output is capped and masked. sudo, force push and deleting the disk or home are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: project,
        command: text,
        timeout_s: { type: 'integer', minimum: 1, maximum: 600, default: 120 },
        session_id: runSession,
        conversation_id: runConversation,
      },
      required: ['project_id', 'command'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'install_cursor_cli',
    description:
      'Install Cursor CLI for this machine from its official source. Requires execute access to the selected project. Returns the installed path and version, or an execution_id while installation is running.',
    inputSchema: { type: 'object', properties: { project_id: project }, required: ['project_id'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'get_command_result',
    description:
      'Status, exit code and output of a run_command / git_commit / git_push execution; page output with cursor (next_cursor).',
    inputSchema: {
      type: 'object',
      properties: { execution_id: text, cursor },
      required: ['execution_id'],
    },
    annotations: readOnly,
  },
  {
    name: 'cancel_command',
    description: 'Stop a running execution started by you.',
    inputSchema: { type: 'object', properties: { execution_id: text }, required: ['execution_id'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'git_commit',
    description:
      'Stage and commit in a project granted git_commit: all changes, or only the given paths. Optionally pass session_id or conversation_id to associate the execution with an existing session; this does not send input to its CLI. Refused if a sensitive file would be committed. Returns the commit and files.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: project,
        message: text,
        paths: { type: 'array', items: { type: 'string' }, description: 'relative paths; omit for all changes' },
        session_id: runSession,
        conversation_id: runConversation,
      },
      required: ['project_id', 'message'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'git_push',
    description:
      'Push in a project granted git_push: the current branch to its upstream, or remote + branch. Optionally pass session_id or conversation_id to associate the execution with an existing session; this does not send input to its CLI. Never forces.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: project,
        remote: text,
        branch: text,
        session_id: runSession,
        conversation_id: runConversation,
      },
      required: ['project_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'read_session_memory',
    description:
      "Read the memory of the Human a session works as: its meta index (one line per skill, knowledge note and experience) and entry list; pass entry to read one entry in full. Read it before planning work for that session.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: project,
        session_id: text,
        entry: { type: 'string', description: 'entry name from the list; omit for the index' },
      },
      required: ['project_id', 'session_id'],
    },
    annotations: readOnly,
  },
  {
    name: 'record_memory',
    description:
      "Save what was learned into the memory of the Human whose session did the work, so its next session and your next chat recall it. kind=experience: what happened, what was done, outcome, lesson, when it applies. kind=knowledge: lasting facts about the project. Notes the Human wrote itself are never overwritten.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: project,
        session_id: text,
        kind: { type: 'string', enum: ['experience', 'knowledge'] },
        name: { type: 'string', description: 'short entry name; becomes the file name' },
        summary: { type: 'string', description: 'one line for the index (≤200 chars)' },
        content: { type: 'string', description: 'the note in Markdown (≤16000 chars)' },
        update: { type: 'boolean', default: false, description: 'replace an entry you wrote earlier' },
      },
      required: ['project_id', 'session_id', 'kind', 'name', 'summary', 'content'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'list_sessions',
    description:
      'List live Ateam CLI sessions in approved projects: stable session id, the Human it works as, provider, model and state (idle/working). On every new Ateam chat, rediscover real sessions and call list_projects; do not claim unavailability without trying. Use observed outcomes as well as model capability to choose work. Does not start sessions.',
    inputSchema: { type: 'object', properties: { cursor } },
    annotations: readOnly,
  },
  {
    name: 'send_message',
    description:
      'Send one bounded task to an existing CLI session. The coordinator owns product scope and acceptance; verify the worker result independently. Pass conversation_id to continue an earlier conversation with that session. The message is submitted at once (a busy CLI queues it). Returns conversation_id and message_id, not an answer: then poll get_messages until the reply arrives. Reuse idempotency_key only to retry this same call.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: project,
        session_id: text,
        message: text,
        idempotency_key: text,
        conversation_id: text,
      },
      required: ['project_id', 'session_id', 'message', 'idempotency_key'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'get_messages',
    description:
      'Read your conversation with a session from a cursor. Poll from next_cursor with growing intervals until a message with in_reply_to equal to your message_id appears; keep the cursor for the next turn.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: project,
        conversation_id: text,
        cursor,
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
      },
      required: ['project_id', 'conversation_id'],
    },
    annotations: readOnly,
  },
  {
    name: 'list_conversations',
    description:
      'Recover your conversations in a project (after reconnecting or in a new chat), then continue them by conversation_id.',
    inputSchema: {
      type: 'object',
      properties: { project_id: project, cursor },
      required: ['project_id'],
    },
    annotations: readOnly,
  },
  {
    name: 'cancel_message',
    description: 'Cancel a message that has not been submitted yet. Never interrupts the session.',
    inputSchema: {
      type: 'object',
      properties: { project_id: project, conversation_id: text, message_id: text },
      required: ['project_id', 'conversation_id', 'message_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];
