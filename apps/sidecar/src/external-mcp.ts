import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  CAPABILITIES,
  EXTERNAL_INSTRUCTIONS,
  type Capability,
  EXTERNAL_TOOLS,
  type ExternalAccess,
  ExternalExec,
  gitCommit,
  gitPush,
  readMemory,
  recordMemory,
  runCommand,
  ExternalConversations,
  ProjectTools,
  installCursorCli,
  type SessionManager,
  ateamHome,
} from '@ateam/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { startPublicMcp } from './public-mcp';

const configSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8765),
  clients: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        token: z.string().min(32).max(256),
        projects: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1)
    .max(100),
});
type Config = z.infer<typeof configSchema>;
interface CursorInstallLock {
  clientId: string;
  executionId?: string;
  timer?: ReturnType<typeof setInterval>;
}
const cursorInstallLocks = new WeakMap<ExternalExec, CursorInstallLock>();

function clearCursorInstallLock(exec: ExternalExec, lock: CursorInstallLock): void {
  if (cursorInstallLocks.get(exec) !== lock) return;
  if (lock.timer) clearInterval(lock.timer);
  cursorInstallLocks.delete(exec);
}

function readConfig(path: string): Config {
  if (process.platform !== 'win32' && statSync(path).mode & 0o077)
    throw new Error('External MCP config must be private (chmod 600).');
  const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (
    new Set(config.clients.map((c) => c.id)).size !== config.clients.length ||
    new Set(config.clients.map((c) => c.token)).size !== config.clients.length
  )
    throw new Error('External MCP client IDs and tokens must be unique.');
  return config;
}

function equal(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('request_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function conversationMcp(
  store: ExternalConversations,
  clientId: string,
  extras: {
    access?: ExternalAccess;
    exec?: ExternalExec;
    installCursorCli?: typeof installCursorCli;
  } = {},
): McpServer {
  const server = new McpServer(
    { name: 'ateam-external', version: '0.1.0' },
    {
      instructions: `${EXTERNAL_INSTRUCTIONS}\n\nEach credential has its own conversations and authorized projects.`,
    },
  );
  const result = (fn: () => unknown) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(fn()) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : 'operation_failed',
          },
        ],
      };
    }
  };
  const project = z.string().regex(/^[a-f0-9]{24}$/);
  const cursor = z.number().int().min(0).max(1_000_000).default(0);
  // Read-only project access (requirements §3.1): no CLI session involved.
  const files = new ProjectTools((projectId) => store.projectRoot(clientId, projectId));
  const asyncResult = async (fn: () => Promise<unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await fn()) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: error instanceof Error ? error.message : 'operation_failed' },
        ],
      };
    }
  };
  const describe = (name: string) =>
    EXTERNAL_TOOLS.find((t) => t.name === name)?.description ?? name;
  server.registerTool(
    'list_projects',
    { description: describe('list_projects'), inputSchema: {}, annotations: { readOnlyHint: true } },
    () => result(() => ({ projects: store.listProjects(clientId) })),
  );
  server.registerTool(
    'get_project_context',
    {
      description: describe('get_project_context'),
      inputSchema: { project_id: project },
      annotations: { readOnlyHint: true },
    },
    ({ project_id }) => asyncResult(() => files.context(project_id)),
  );
  server.registerTool(
    'search_code',
    {
      description: describe('search_code'),
      inputSchema: {
        project_id: project,
        query: z.string().min(1).max(500),
        regex: z.boolean().default(false),
        path_prefix: z.string().max(1000).optional(),
        glob: z.string().max(200).optional(),
        max_results: z.number().int().min(1).max(100).default(30),
        cursor,
      },
      annotations: { readOnlyHint: true },
    },
    ({ project_id, ...q }) => asyncResult(() => files.searchCode(project_id, q)),
  );
  server.registerTool(
    'read_file',
    {
      description: describe('read_file'),
      inputSchema: {
        project_id: project,
        path: z.string().max(1000),
        start_line: z.number().int().min(1).default(1),
        end_line: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project_id, path, start_line, end_line }) =>
      asyncResult(async () => files.readFile(project_id, path, start_line, end_line)),
  );
  server.registerTool(
    'get_git_status',
    {
      description: describe('get_git_status'),
      inputSchema: { project_id: project },
      annotations: { readOnlyHint: true },
    },
    ({ project_id }) => asyncResult(() => files.gitStatus(project_id)),
  );
  server.registerTool(
    'get_git_diff',
    {
      description: describe('get_git_diff'),
      inputSchema: {
        project_id: project,
        base_ref: z.string().max(200).optional(),
        head_ref: z.string().max(200).optional(),
        staged: z.boolean().default(false),
        path_prefix: z.string().max(1000).optional(),
        cursor,
      },
      annotations: { readOnlyHint: true },
    },
    ({ project_id, ...q }) => asyncResult(() => files.gitDiff(project_id, q)),
  );
  // Memory of the Human behind a session: read before planning, record after verifying.
  server.registerTool(
    'read_session_memory',
    {
      description: describe('read_session_memory'),
      inputSchema: {
        project_id: project,
        session_id: z.string().min(1).max(128),
        entry: z.string().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project_id, session_id, entry }) =>
      result(() => {
        const human = store.humanOf(clientId, project_id, session_id);
        return readMemory(human.id, human.name, entry);
      }),
  );
  server.registerTool(
    'record_memory',
    {
      description: describe('record_memory'),
      inputSchema: {
        project_id: project,
        session_id: z.string().min(1).max(128),
        kind: z.enum(['experience', 'knowledge']),
        name: z.string().min(1).max(120),
        summary: z.string().min(1).max(200),
        content: z.string().min(1).max(16_000),
        update: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ project_id, session_id, ...note }) =>
      result(() => recordMemory(store.humanOf(clientId, project_id, session_id), note, clientId)),
  );
  // Access requests and granted actions (execute / git_commit / git_push). A grant is
  // per project and lasts until revoked; every action is audited by ExternalExec.
  const { access, exec } = extras;
  const granted = (projectId: string, capability: Capability) => {
    if (!access || !exec) throw new Error('not available in this server mode');
    const root = store.projectRoot(clientId, projectId);
    if (!access.can(clientId, root, capability))
      throw new Error(
        `capability_not_granted: call request_project_access with path "${root}" and capabilities ["${capability}"], then wait for the user to approve it in Ateam`,
      );
    return { root, exec };
  };
  const capability = z.enum(CAPABILITIES);
  server.registerTool(
    'request_project_access',
    {
      description: describe('request_project_access'),
      inputSchema: {
        path: z.string().min(1).max(1000),
        capabilities: z.array(capability).max(4).default([]),
        reason: z.string().min(1).max(500),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ path, capabilities, reason }) =>
      result(() => {
        if (!access) throw new Error('not available in this server mode');
        return access.requestAccess(clientId, path, capabilities, reason);
      }),
  );
  server.registerTool(
    'list_pending_authorizations',
    {
      description: describe('list_pending_authorizations'),
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      result(() => {
        if (!access) throw new Error('not available in this server mode');
        const { requests, granted: held } = access.authorizations(clientId);
        const ids = new Map(store.listProjects(clientId).map((p) => [p.root, p.project_id]));
        return { requests, granted: held.map((g) => ({ project_id: ids.get(g.root) ?? null, ...g })) };
      }),
  );
  server.registerTool(
    'run_command',
    {
      description: describe('run_command'),
      inputSchema: {
        project_id: project,
        command: z.string().min(1).max(8000),
        timeout_s: z.number().int().min(1).max(600).default(120),
        session_id: z.string().min(1).max(128).optional(),
        conversation_id: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    ({ project_id, command, timeout_s, session_id, conversation_id }) =>
      asyncResult(async () => {
        const g = granted(project_id, 'execute');
        const link = store.resolveRunLink(clientId, project_id, session_id, conversation_id);
        return runCommand(g.exec, { clientId, root: g.root, link }, command, timeout_s);
      }),
  );
  server.registerTool(
    'install_cursor_cli',
    {
      description: describe('install_cursor_cli'),
      inputSchema: { project_id: project },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ project_id }) =>
      asyncResult(async () => {
        const g = granted(project_id, 'execute');
        const prior = cursorInstallLocks.get(g.exec);
        if (prior) {
          // Installation is machine-global. Do not expose another client's
          // execution id; the authorization check above still runs first.
          if (prior.clientId !== clientId || !prior.executionId)
            return { status: 'in_progress' };
          try {
            const execution = g.exec.get(clientId, prior.executionId);
            if (execution.status === 'running')
              return { status: 'running', execution_id: prior.executionId };
          } catch {
            // A missing record cannot keep the machine-global lock wedged.
          }
          clearCursorInstallLock(g.exec, prior);
        }
        const installer = extras.installCursorCli ?? installCursorCli;
        // Reserve the machine-wide slot before the installer can yield while
        // probing an existing CLI or checking its version.
        const lock: CursorInstallLock = { clientId };
        cursorInstallLocks.set(g.exec, lock);
        try {
          const install = await installer({
            runInstall: async (script, timeoutMs, path) => {
              const run = await g.exec.start({
                clientId,
                root: g.root,
                tool: 'install_cursor_cli',
                argv: ['bash', '-c', script],
                timeoutMs,
                displayCommand: 'Install Cursor CLI from official source',
                env: { PATH: path },
              });
              if (run.status === 'running') {
                lock.executionId = run.execution_id;
                lock.timer = setInterval(() => {
                  try {
                    if (g.exec.get(clientId, run.execution_id).status !== 'running')
                      clearCursorInstallLock(g.exec, lock);
                  } catch {
                    clearCursorInstallLock(g.exec, lock);
                  }
                }, 250);
                lock.timer.unref?.();
                return { status: 'running', executionId: run.execution_id, output: run.output };
              }
              if (run.status !== 'exited' || run.exit_code !== 0) {
                throw new Error(`Cursor CLI installer ${run.status}: ${run.output}`);
              }
              return run.output;
            },
          });
          if (install.status === 'running')
            return { status: install.status, execution_id: install.executionId };
          if (install.status === 'already_installed' || install.status === 'installed')
            return { status: install.status, path: install.path, version: install.version };
          return { status: install.status, error: install.error };
        } finally {
          // Keep the lock only while a real ExternalExec is still running.
          if (!lock.executionId) clearCursorInstallLock(g.exec, lock);
        }
      }),
  );
  server.registerTool(
    'get_command_result',
    {
      description: describe('get_command_result'),
      inputSchema: { execution_id: z.string().uuid(), cursor },
      annotations: { readOnlyHint: true },
    },
    ({ execution_id, cursor }) =>
      result(() => {
        if (!exec) throw new Error('not available in this server mode');
        return exec.get(clientId, execution_id, cursor);
      }),
  );
  server.registerTool(
    'cancel_command',
    {
      description: describe('cancel_command'),
      inputSchema: { execution_id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ execution_id }) =>
      result(() => {
        if (!exec) throw new Error('not available in this server mode');
        return exec.cancel(clientId, execution_id);
      }),
  );
  server.registerTool(
    'git_commit',
    {
      description: describe('git_commit'),
      inputSchema: {
        project_id: project,
        message: z.string().min(1).max(5000),
        paths: z.array(z.string().min(1).max(1000)).max(500).optional(),
        session_id: z.string().min(1).max(128).optional(),
        conversation_id: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ project_id, message, paths, session_id, conversation_id }) =>
      asyncResult(async () => {
        const g = granted(project_id, 'git_commit');
        const link = store.resolveRunLink(clientId, project_id, session_id, conversation_id);
        return gitCommit(
          g.exec,
          files,
          { clientId, root: g.root, projectId: project_id, link },
          message,
          paths,
        );
      }),
  );
  server.registerTool(
    'git_push',
    {
      description: describe('git_push'),
      inputSchema: {
        project_id: project,
        remote: z.string().max(200).optional(),
        branch: z.string().max(200).optional(),
        session_id: z.string().min(1).max(128).optional(),
        conversation_id: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ project_id, remote, branch, session_id, conversation_id }) =>
      asyncResult(async () => {
        const g = granted(project_id, 'git_push');
        const link = store.resolveRunLink(clientId, project_id, session_id, conversation_id);
        return gitPush(g.exec, { clientId, root: g.root, link }, remote, branch);
      }),
  );
  server.registerTool(
    'list_sessions',
    {
      description:
        'List live sessions in authorized projects, with stable full IDs. Does not start sessions.',
      inputSchema: { cursor },
      annotations: { readOnlyHint: true },
    },
    ({ cursor }) =>
      result(() => {
        const all = store.listSessions(clientId);
        return {
          sessions: all.slice(cursor, cursor + 20),
          next_cursor: cursor + 20 < all.length ? cursor + 20 : null,
        };
      }),
  );
  server.registerTool(
    'send_message',
    {
      description:
        'Queue a message to an existing session. Returns conversation_id/message_id, not an AI answer. Reuse idempotency_key on transport retries. Poll get_messages for explicit replies.',
      inputSchema: {
        project_id: project,
        session_id: z.string().min(1).max(128),
        conversation_id: z.string().uuid().optional(),
        message: z.string().trim().min(1).max(16_000),
        idempotency_key: z.string().min(1).max(128),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (args) => result(() => store.send(clientId, args)),
  );
  server.registerTool(
    'list_conversations',
    {
      description:
        'Recover this client’s conversations after disconnect. Other clients’ conversations are not visible.',
      inputSchema: { project_id: project, cursor },
      annotations: { readOnlyHint: true },
    },
    ({ project_id, cursor }) => result(() => store.listConversations(clientId, project_id, cursor)),
  );
  server.registerTool(
    'cancel_message',
    {
      description:
        'Cancel an undelivered queued message owned by this client. Never interrupts or kills a CLI session.',
      inputSchema: {
        project_id: project,
        conversation_id: z.string().uuid(),
        message_id: z.string().uuid(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ project_id, conversation_id, message_id }) =>
      result(() => store.cancel(clientId, project_id, conversation_id, message_id)),
  );
  server.registerTool(
    'get_messages',
    {
      description:
        'Read this client’s conversation. Poll next_cursor for new replies; reread an earlier cursor to refresh delivery status. No terminal history is exposed.',
      inputSchema: {
        project_id: project,
        conversation_id: z.string().uuid(),
        cursor,
        limit: z.number().int().min(1).max(20).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project_id, conversation_id, cursor, limit }) =>
      result(() => store.read(clientId, project_id, conversation_id, cursor, limit)),
  );
  return server;
}

/** Opt-in loopback endpoint. Every request is authenticated independently. */
export async function startExternalMcp(
  sessions: SessionManager,
  path?: string,
  access?: ExternalAccess,
) {
  const config = path ? readConfig(path) : { port: access?.port ?? 8765, clients: [] };
  if (!path && !access) throw new Error('Missing authorization manager');
  let store: ExternalConversations;
  let serverLive = false;
  const exec = access
    ? new ExternalExec(ateamHome(), (run) => {
        if (serverLive && typeof sessions.emit === 'function')
          sessions.emit('externalRun', { sessionId: run.sessionId, run });
      })
    : undefined;
  const fingerprint = JSON.stringify(config);
  // Changing/removing the config revokes all new calls and delivery until restart.
  const enabled = () => {
    try {
      return !path || JSON.stringify(readConfig(path)) === fingerprint;
    } catch {
      return false;
    }
  };
  const counts = new Map<string, { start: number; count: number }>();
  let active = 0;
  const http = createServer(async (req, res) => {
    // Local transport only; a reverse proxy must retain the upstream Host and omit browser Origin.
    if (
      ![`127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(req.headers.host ?? '') ||
      req.headers.origin
    ) {
      res.writeHead(403).end();
      return;
    }
    if (access && req.url === '/connect' && req.method === 'POST') {
      const status = access.attempt(req.headers.authorization ?? '');
      res
        .writeHead(status ? 200 : 401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ status: status ?? 'unknown' }));
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!enabled()) {
      res.writeHead(503).end();
      return;
    }
    const auth = req.headers.authorization ?? '';
    const client = access
      ? access.authenticate(auth)
      : config.clients.find((c) => equal(auth, `Bearer ${c.token}`));
    if (client && 'status' in client && client.status !== 'approved') {
      access?.attempt(auth);
      res.writeHead(403).end('Approve this connection in Ateam.');
      return;
    }
    if (!client) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }
    await serve(req, res, client.id);
  });
  /** One MCP request for an already-authorized client (local token or remote OAuth). */
  const serve = async (req: IncomingMessage, res: ServerResponse, clientId: string) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const now = Date.now();
    let rate = counts.get(clientId);
    if (!rate || now - rate.start >= 60_000) {
      rate = { start: now, count: 0 };
      counts.set(clientId, rate);
    }
    if (++rate.count > 120 || active >= 32) {
      res.writeHead(429, { 'Retry-After': '5' }).end();
      return;
    }
    active++;
    const mcp = conversationMcp(store, clientId, { access, exec });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      const parsed = await body(req);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch {
      if (!res.headersSent) res.writeHead(400).end('invalid_request');
      else res.end();
    } finally {
      await mcp.close();
      active--;
    }
  };
  http.requestTimeout = 15_000;
  http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, '127.0.0.1', resolve);
  });
  try {
    store = new ExternalConversations(
      ateamHome(),
      (access?.approved() ?? config.clients).map((c) => ({ id: c.id, roots: c.projects })),
      {
        list: () => sessions.listPeerSessions(),
        deliver: (id, envelope) => sessions.deliverExternalMessage(id, envelope),
      },
    );
  } catch (error) {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    throw error;
  }
  const updateGrants = () =>
    store.setClients(
      (access?.approved() ?? config.clients).map((c) => ({ id: c.id, roots: c.projects })),
    );
  access?.on('changed', updateGrants);
  if (access) {
    access.endpoint = `http://127.0.0.1:${config.port}/mcp`;
    access.emit('changed');
  }
  const remote = access
    ? await startPublicMcp({
        access,
        port: config.port + 2,
        serve: (req, res, clientId) =>
          enabled() ? serve(req, res, clientId) : void res.writeHead(503).end(),
      }).catch((error) => {
        access.error = error instanceof Error ? error.message : 'Public MCP could not start.';
        return undefined;
      })
    : undefined;
  sessions.externalReply = (sender, address, message) => {
    if (!enabled()) throw new Error('external_mcp_revoked');
    store.reply(sender, address, message);
  };
  sessions.externalRuns = (sessionId) => {
    const peer = sessions
      .listPeerSessions()
      .find((candidate) => candidate.id === sessionId && candidate.state !== 'exited');
    if (!peer || !exec) return [];
    return exec.listLinked(peer.stable_id ?? peer.id, sessionId);
  };
  const timer = setInterval(() => {
    if (!enabled()) return;
    try {
      store.pump();
    } catch {
      process.stderr.write('[external-mcp] conversation persistence/delivery failed\n');
    }
  }, 1000);
  timer.unref();
  // Requests the relay forwards for web connectors: one 'relay' client per machine,
  // approved here like any other client.
  const relayHttp = createServer(async (req, res) => {
    if (!access || req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const status = access.touch('relay', 'Web connectors via Ateam relay');
    if (status !== 'approved') {
      res
        .writeHead(403, { 'Content-Type': 'application/json' })
        .end(
          JSON.stringify({ error: status === 'pending' ? 'approval_pending' : `access_${status}` }),
        );
      return;
    }
    await serve(req, res, 'relay');
  });
  relayHttp.requestTimeout = 15_000;
  serverLive = true;
  return {
    acceptRelay: (stream: Duplex) => relayHttp.emit('connection', stream),
    close: async () => {
      serverLive = false;
      clearInterval(timer);
      await remote?.close();
      access?.off('changed', updateGrants);
      if (access) access.endpoint = '';
      sessions.externalReply = undefined;
      sessions.externalRuns = undefined;
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
