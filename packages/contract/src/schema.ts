import { z } from 'zod';
import { PROVIDER_IDS } from './domain';
import type { Envelope } from './envelope';
import { PROTOCOL_VERSION } from './envelope';
import type { EventTopic } from './events';
import type { MethodName } from './methods';

export class ProtocolValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolValidationError';
  }
}

const zVersion = z.literal(PROTOCOL_VERSION);
const zProviderId = z.enum(PROVIDER_IDS);

const zReq = z.object({
  v: zVersion,
  kind: z.literal('req'),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown(),
});
const zResOk = z.object({
  v: zVersion,
  kind: z.literal('res'),
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown(),
});
const zResErr = z.object({
  v: zVersion,
  kind: z.literal('res'),
  id: z.string().min(1),
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), data: z.unknown().optional() }),
});
const zEvt = z.object({
  v: zVersion,
  kind: z.literal('evt'),
  topic: z.string().min(1),
  corr: z.string().optional(),
  seq: z.number().int().nonnegative(),
  data: z.unknown(),
});

export const zEnvelope = z.union([zReq, zResOk, zResErr, zEvt]);

// --- domain sub-schemas ---
const zWorkspace = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  root: z.string().min(1),
  repo: z.object({ root: z.string(), isolation: z.enum(['worktree', 'none']) }).optional(),
  techStack: z.array(z.string()).optional(),
  defaultRole: z.string().optional(),
});
const zSessionState = z.enum(['starting', 'running', 'idle', 'hibernated', 'exited']);
const zTurn = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  text: z.string(),
  at: z.string().min(1),
  kind: z.enum(['text', 'thinking', 'tool_use', 'tool_result']).optional(),
  toolName: z.string().optional(),
  tokens: z.number().int().nonnegative().optional(),
  queued: z.boolean().optional(),
  dequeued: z.boolean().optional(),
  injected: z.enum(['handoff', 'mid_turn', 'compaction']).optional(),
});
const zExternalRun = z
  .object({
    executionId: z.string().min(1),
    sessionId: z.string().min(1),
    tool: z.string().min(1),
    // Redaction can expand a command slightly (e.g. short password assignments).
    command: z.string().max(16 * 1024),
    status: z.enum(['running', 'exited', 'timed_out', 'cancelled', 'failed_to_start']),
    exitCode: z.number().int().nullable(),
    startedAt: z.string().min(1),
    endedAt: z.string().min(1).nullable(),
    output: z.string().max(32 * 1024),
    truncated: z.boolean(),
  })
  .strict();

/** zod schemas for the LIVE method params (reserved methods validated later). */
export const methodParamsSchema = {
  'externalMcp.status': z.object({}),
  'externalMcp.register': z.object({
    client: z.enum(['claude-desktop', 'chatgpt', 'cursor-desktop']),
  }),
  'externalMcp.decide': z.object({ id: z.string().min(1), allow: z.boolean(), projects: z.array(z.string().min(1)).max(100) }),
  'externalMcp.decideRequest': z.object({ id: z.string().min(1), allow: z.boolean() }),
  'externalMcp.revoke': z.object({ id: z.string().min(1) }),
  'externalMcp.retry': z.object({ id: z.string().min(1) }),
  'session.spawn': z.object({
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    agentName: z.string().min(1),
    role: z.string().min(1),
    human: z
      .object({
        id: z.string().optional(),
        name: z.string().min(1),
        role: z.string().min(1),
        provider: z.string().optional(),
      })
      .optional(),
    workspace: zWorkspace.optional(),
    directoryless: z.boolean().optional(),
    resumeSessionId: z.string().optional(),
    providerId: zProviderId.optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
  }),
  'claude.sessions': z
    .object({ cwd: z.string().min(1).optional(), humanId: z.string().min(1).optional() })
    .refine((p) => Boolean(p.cwd || p.humanId), { message: 'cwd or humanId required' }),
  'session.input': z.object({ sessionId: z.string().min(1), data: z.string() }),
  'files.search': z.object({
    dir: z.string().min(1),
    query: z.string(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  'session.pullQueue': z.object({
    sessionId: z.string().min(1),
    clearChars: z.number().int().min(0),
  }),
  'session.viewport': z.object({
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  'session.resize': z.object({
    sessionId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  'session.activate': z.object({ sessionId: z.string().min(1) }),
  'session.list': z.object({}),
  'session.kill': z.object({ sessionId: z.string().min(1) }),
  'session.delete': z.object({ sessionId: z.string().min(1) }),
  'session.raw': z.object({ sessionId: z.string().min(1) }),
  // ~20MB of base64 (15MB file) — a phone photo is 2–6MB
  'file.upload': z.object({
    name: z.string().min(1).max(200),
    base64: z.string().min(1).max(28_000_000),
  }),
  'session.transcript': z.object({
    sessionId: z.string().min(1),
    since: z.number().int().nonnegative().optional(),
  }),
  'session.externalRuns': z.object({ sessionId: z.string().min(1) }).strict(),
  'session.reassignHuman': z.object({
    sessionId: z.string().min(1),
    humanId: z.string().min(1),
  }),
  'flywheel.reflect': z.object({ sessionId: z.string().min(1) }),
  'asset.search': z.object({
    agentKey: z.string().min(1),
    query: z.string(),
    domain: z.string().optional(),
    projectId: z.string().optional(),
  }),
  'agent.growth': z.object({ agentKey: z.string().min(1) }),
  'human.metaDir': z.object({ humanId: z.string().min(1) }),
  'human.meta': z.object({ humanId: z.string().min(1) }),
  'usage.recent': z.object({ limit: z.number().int().positive().optional() }),
  'app.list': z.object({}),
  'app.openPath': z.object({
    // '' is MEANINGFUL: the OS default handler for that file type. The client
    // sends it for every file the in-app viewer cannot preview (a .pdf, a
    // .zip) and whenever no Open With app is configured — `min(1)` refused
    // all of those, and the only thing the user saw was a zod dump.
    appName: z.string(),
    path: z.string().min(1),
    cwd: z.string().optional(),
  }),
  'dir.list': z.object({ path: z.string().min(1) }),
  'file.read': z.object({ path: z.string().min(1) }),
  'file.videoChunk': z.object({
    path: z.string().min(1),
    offset: z.number().int().min(0).max(128 * 1024 * 1024),
    length: z.number().int().min(1).max(256 * 1024),
    version: z.string().min(1).max(200).optional(),
  }),
  'file.thumb': z.object({ path: z.string().min(1), max: z.number().int().positive().optional() }),
  'browser.shot': z.object({ sessionId: z.string().min(1), width: z.number().int().positive().max(1600).optional() }),
  'file.write': z.object({ path: z.string().min(1), text: z.string() }),
  'provider.list': z.object({}),
  'sessionState.get': z.object({}),
  'sessionState.set': z.object({
    agents: z.array(
      z.object({
        projectName: z.string(),
        agentName: z.string(),
        role: z.string(),
        dir: z.string(),
        claudeSessionId: z.string(),
        directoryless: z.boolean().optional(),
        providerId: zProviderId.optional(),
      }),
    ),
    focusedClaudeSessionId: z.string().optional(),
  }),
  'agent.expertise': z.object({ agentKey: z.string().min(1) }),
  'skill.adoptHumanDirs': z.object({
    humanId: z.string().optional(),
    all: z.boolean().optional(),
  }),
  'skill.import': z.object({
    agentKey: z.string().min(1),
    dir: z.string().min(1),
    scope: z.enum(['project', 'global']).optional(),
  }),
  'skill.learn': z.object({
    agentKey: z.string().min(1),
    projectDir: z.string().min(1),
    scope: z.enum(['project', 'global']).optional(),
  }),
  'skill.sources': z.object({ projectDir: z.string().optional() }),
  'skill.units': z.object({ projectDir: z.string().optional() }),
  'skill.importUnit': z.object({
    humanId: z.string().min(1),
    unitPath: z.string().min(1),
    kind: z.enum(['file', 'bundle', 'tree']),
    entry: z.string(),
    scope: z.enum(['project', 'global']).optional(),
  }),
  'meta.runNow': z.object({}),
  'project.recent': z.object({}),
  'workspace.info': z.object({ dir: z.string().min(1), fresh: z.boolean().optional() }),
  'fs.watch': z.object({ dir: z.string().min(1) }),
  'fs.unwatch': z.object({ dir: z.string().min(1) }),
  'workspace.gitLog': z.object({
    dir: z.string().min(1),
    limit: z.number().int().positive().max(500).optional(),
  }),
  'workspace.commitFiles': z.object({
    dir: z.string().min(1),
    hash: z.string().regex(/^[0-9a-f]{4,40}$/i),
  }),
  'workspace.diff': z.object({
    dir: z.string().min(1),
    path: z.string().min(1),
    hash: z
      .string()
      .regex(/^[0-9a-f]{4,40}$/i)
      .optional(),
  }),
  'workspace.remotes': z.object({ dir: z.string().min(1) }),
  'workspace.branches': z.object({ dir: z.string().min(1) }),
  'workspace.checkout': z.object({ dir: z.string().min(1), branch: z.string().min(1).max(255) }),
  'workspace.worktrees': z.object({ dir: z.string().min(1) }),
  'path.reveal': z.object({ path: z.string().min(1) }),
  'path.firstExisting': z.object({ paths: z.array(z.string()).max(64) }),
  'path.resolve': z.object({
    sessionId: z.string().min(1),
    ref: z.string().min(1).max(4096),
    roots: z.array(z.string()).max(32).optional(),
  }),
  'path.createDir': z.object({
    parent: z.string().min(1).max(4096),
    name: z.string().min(1).max(255),
  }),
  'task.list': z.object({
    project: z.string().optional(),
    status: z.enum(['open', 'done']).optional(),
  }),
  'task.add': z.object({
    title: z.string().min(1).max(200),
    body: z.string().max(20000).optional(),
    project: z.string().optional(),
    remindAt: z.number().int().positive().optional(),
    tags: z.array(z.string().max(24)).max(3).optional(),
  }),
  'task.complete': z.object({ id: z.string().min(1) }),
  'task.reopen': z.object({ id: z.string().min(1) }),
  'task.remove': z.object({ id: z.string().min(1) }),
  'chat.list': z.object({}),
  'chat.create': z.object({
    kind: z.enum(['dm', 'group']),
    name: z.string(),
    members: z.array(z.string()),
    workdir: z.string().optional(),
    purpose: z.string().optional(),
  }),
  'chat.update': z.object({
    chatId: z.string().min(1),
    name: z.string().optional(),
    members: z.array(z.string()).optional(),
    workdir: z.string().optional(),
    purpose: z.string().optional(),
  }),
  'chat.delete': z.object({ chatId: z.string().min(1) }),
  'chat.messages': z.object({ chatId: z.string().min(1), sinceTs: z.number().optional() }),
  'chat.send': z.object({ chatId: z.string().min(1), text: z.string().min(1) }),
  'chat.usage': z.object({ chatId: z.string().min(1) }),
  'session.locate': z.object({
    claudeSessionId: z.string().min(1).max(128),
    dir: z.string().optional(),
  }),
  'project.setAlias': z.object({
    projectId: z.string().min(1).max(512),
    alias: z.string().max(60), // '' clears the alias
  }),
  'url.open': z.object({
    url: z
      .string()
      .regex(/^https?:\/\//i)
      .max(4096),
  }),
  'app.icons': z.object({}),
  'human.list': z.object({}),
  'human.create': z.object({
    name: z.string().min(1),
    role: z.string().min(1),
    provider: z.string().optional(),
    notes: z.string().optional(),
  }),
  'human.get': z.object({ id: z.string().min(1) }),
  'human.update': z.object({
    id: z.string().min(1),
    patch: z
      .object({
        name: z.string().min(1).optional(),
        role: z.string().min(1).optional(),
        provider: z.string().optional(),
        notes: z.string().optional(),
        avatarId: z.string().optional(),
        model: z.string().max(64).optional(),
        duties: z.string().max(2000).optional(),
      })
      .refine((p) => Object.keys(p).length > 0, { message: 'patch is empty' }),
  }),
  'human.summarize': z.object({ id: z.string().min(1) }),
  'skill.unassign': z.object({
    humanId: z.string().min(1),
    unitPath: z.string().min(1),
  }),
  'flywheel.distill': z.object({ humanId: z.string().min(1) }),
  'skill.market.list': z.object({
    sourceId: z.string().min(1).optional(),
    query: z.string().optional(),
    limit: z.number().int().positive().optional(),
  }),
  'skill.market.sources': z.object({}),
  'skill.market.addSource': z.object({ repo: z.string().min(1) }),
  'skill.market.removeSource': z.object({ id: z.string().min(1) }),
  'skill.market.setSourceEnabled': z.object({
    id: z.string().min(1),
    enabled: z.boolean(),
  }),
  'skill.market.discover': z.object({}),
  'skill.market.install': z.object({
    humanId: z.string().min(1),
    itemId: z.string().min(1),
    sourceId: z.string().min(1).optional(),
  }),
  'human.market.list': z.object({}),
  'human.market.hire': z.object({
    itemId: z.string().min(1),
    name: z.string().min(1).optional(),
  }),
  'config.get': z.object({}),
  'prompts.list': z.object({}),
  'prompts.set': z.object({
    name: z.string().min(1).max(64),
    text: z.string().max(64_000),
  }),
  'prompts.reset': z.object({ name: z.string().min(1).max(64) }),
  'config.markRole': z.object({
    role: z.string().min(1),
    skillDir: z.string().optional(),
    learnedProject: z.string().optional(),
  }),
  'config.finish': z.object({}),
  'config.set': z.object({
    codegraph: z.boolean().optional(),
    autoResume: z.boolean().optional(),
    desktopView: z.enum(['terminal', 'stream']).optional(),
    autoHandoff: z
      .object({
        enabled: z.boolean().optional(),
        thresholdTokens: z.number().int().positive().optional(),
      })
      .optional(),
    experienceCheckpoint: z
      .object({
        enabled: z.boolean().optional(),
        thresholdTokens: z.number().int().positive().optional(),
      })
      .optional(),
    proxy: z
      .object({
        enabled: z.boolean().optional(),
        url: z.string().max(2000).optional(),
      })
      .optional(),
    hibernate: z
      .object({
        enabled: z.boolean().optional(),
        idleHours: z.number().int().positive().max(720).optional(),
      })
      .optional(),
    lan: z
      .object({
        enabled: z.boolean().optional(),
        port: z.number().int().min(1024).max(65535).optional(),
        password: z.string().min(4).max(256).optional(),
      })
      .optional(),
    remote: z
      .object({
        enabled: z.boolean().optional(),
        url: z.string().max(512).optional(),
        deviceId: z.string().max(128).optional(),
        token: z.string().max(512).optional(),
        tlsFingerprint: z.string().max(128).optional(),
      })
      .optional(),
  }),
  'lan.status': z.object({}),
  'remote.status': z.object({}),
  'sync.status': z.object({}),
  'sync.enable': z.object({ passphrase: z.string().min(8).max(256) }),
  'sync.disable': z.object({}),
  'sync.now': z.object({}),
  'sync.changePassphrase': z.object({
    current: z.string().min(1).max(256),
    next: z.string().min(8).max(256),
  }),
  'sync.devices': z.object({}),
  'remote.createInvite': z.object({
    uses: z.number().int().min(1).max(5).optional(),
    days: z.number().int().min(1).max(30).optional(),
  }),
  'sync.renameDevice': z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(60) }),
  'sync.revokeDevice': z.object({ id: z.string().min(1).max(64) }),
  'remote.register': z.object({
    baseUrl: z.string().min(8).max(512),
    email: z.string().min(3).max(200),
    password: z.string().min(1).max(256),
    name: z.string().min(1).max(60),
    tlsFingerprint: z.string().max(128).optional(),
    invite: z.string().max(64).optional(),
  }),
  'remote.signIn': z.object({
    email: z.string().min(3).max(200),
    password: z.string().min(1).max(256),
    name: z.string().min(1).max(60).optional(),
    baseUrl: z.string().min(8).max(512).optional(),
    invite: z.string().max(64).optional(),
  }),
  'session.usage': z.object({ sessionId: z.string().min(1) }),
  'usage.plan': z.object({ sessionId: z.string().min(1) }),
  'session.hibernate': z.object({ sessionId: z.string().min(1) }),
  'session.wake': z.object({ sessionId: z.string().min(1), fork: z.boolean().optional() }),
  'session.addHibernated': z.object({
    projectName: z.string(),
    agentName: z.string().min(1),
    role: z.string().min(1),
    dir: z.string().min(1),
    claudeSessionId: z.string().min(1),
    directoryless: z.boolean().optional(),
    providerId: zProviderId.optional(),
  }),
  'session.estimateTokens': z.object({ sessionId: z.string().min(1) }),
  'claude.commands': z.object({ sessionId: z.string().min(1) }),
  'session.olderTranscript': z.object({
    sessionId: z.string().min(1),
    beforeByte: z.number().int().nonnegative(),
  }),
  'session.handoffNow': z.object({
    sessionId: z.string().min(1),
    focusHint: z.string().optional(),
    successorProviderId: zProviderId.optional(),
  }),
  'session.switchProvider': z.object({
    sessionId: z.string().min(1),
    targetProviderId: zProviderId,
  }),
} satisfies Partial<Record<MethodName, z.ZodTypeAny>>;

/** zod schemas for the LIVE event data. */
export const eventDataSchema = {
  'externalMcp.changed': z.object({}),
  'session.output': z.object({ sessionId: z.string(), chunk: z.string() }),
  'session.status': z.object({
    sessionId: z.string(),
    state: zSessionState,
    exitCode: z.number().optional(),
  }),
  'session.turn': z.object({ sessionId: z.string(), turn: zTurn }),
  'session.externalRun': z
    .object({ sessionId: z.string().min(1), run: zExternalRun })
    .strict(),
  'session.size': z.object({
    sessionId: z.string(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  'fs.changed': z.object({ dir: z.string(), paths: z.array(z.string()) }),
  'task.changed': z.object({}),
  'chat.changed': z.object({ chatId: z.string().optional() }),
  'task.due': z.object({ id: z.string(), title: z.string(), project: z.string() }),
  'session.replaced': z.object({
    oldSessionId: z.string().min(1),
    newSessionId: z.string().min(1),
    oldClaudeSessionId: z.string().min(1),
    newClaudeSessionId: z.string().min(1),
    handoffPath: z.string().min(1),
    at: z.string().min(1),
  }),
  log: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']), msg: z.string() }),
} satisfies Partial<Record<EventTopic, z.ZodTypeAny>>;

/** Parse + validate any inbound wire message. Throws ProtocolValidationError. */
export function parseEnvelope(raw: unknown): Envelope {
  const r = zEnvelope.safeParse(raw);
  if (!r.success) {
    throw new ProtocolValidationError('bad_request', `invalid envelope: ${r.error.message}`);
  }
  return r.data as Envelope;
}

/** Validate request params for a method. Returns the parsed params. */
export function validateParams(method: string, params: unknown): unknown {
  const s = (methodParamsSchema as Record<string, z.ZodTypeAny | undefined>)[method];
  if (!s) return params; // reserved method: not yet validated
  const r = s.safeParse(params ?? {});
  if (!r.success) {
    throw new ProtocolValidationError(
      'bad_request',
      `invalid params for ${method}: ${r.error.message}`,
    );
  }
  return r.data;
}

/** Validate event data for a topic. Returns the parsed data. */
export function validateEventData(topic: string, data: unknown): unknown {
  const s = (eventDataSchema as Record<string, z.ZodTypeAny | undefined>)[topic];
  if (!s) return data;
  const r = s.safeParse(data);
  if (!r.success) {
    throw new ProtocolValidationError(
      'bad_request',
      `invalid event data for ${topic}: ${r.error.message}`,
    );
  }
  return r.data;
}
