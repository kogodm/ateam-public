import { execFileSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExternalMcpStatus } from '@ateam/contract';
import { installChatgptPlugin } from './chatgpt-plugin';
import { AccessRequests, type Capability, resolveProjectPath } from './external-requests';

interface Client {
  id: string;
  name: string;
  token: string;
  status: ExternalMcpStatus['clients'][number]['status'];
  projects: string[];
  expiresAt?: number;
  lastSeenAt?: number;
  /** last transition into approved; remote tokens issued before it are void */
  approvedAt?: number;
  /** a remote (OAuth) sign-in waiting for the user; never persisted across restarts */
  pairing?: Pairing;
  /** per project root: actions approved once through request_project_access */
  capabilities?: Record<string, Capability[]>;
}

interface Pairing {
  code: string;
  expiresAt: number;
  state: 'pending' | 'approved' | 'denied' | 'expired';
}

const PAIRING_MS = 5 * 60_000;

/** Application-owned consent. MCP callers have no access to approve/revoke operations. */
export class ExternalAccess extends EventEmitter {
  private clients: Client[];
  private readonly file: string;
  port = 8765;
  private saved = '[]';
  private blocked = false;
  endpoint = '';
  error?: string;
  registered = false;
  private chatgptPlugin?: ExternalMcpStatus['chatgptPlugin'];
  publicMcp?: ExternalMcpStatus['publicMcp'];
  private readonly requests: AccessRequests;

  constructor(
    readonly home: string,
    private readonly projectRoots: () => string[],
  ) {
    super();
    mkdirSync(join(home, 'external-mcp'), { recursive: true, mode: 0o700 });
    this.file = join(home, 'external-mcp', 'access.json');
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (
        !Array.isArray(value) ||
        value.some(
          (c) =>
            !c ||
            typeof c.id !== 'string' ||
            typeof c.name !== 'string' ||
            typeof c.token !== 'string' ||
            !Array.isArray(c.projects) ||
            c.projects.some((p: unknown) => typeof p !== 'string') ||
            !['registered', 'pending', 'approved', 'denied', 'revoked', 'expired'].includes(
              c.status,
            ),
        )
      )
        throw new Error('Invalid external MCP access store');
      this.clients = value;
      for (const client of this.clients) {
        client.lastSeenAt = undefined;
        client.pairing = undefined;
        if (client.status === 'pending') client.status = 'expired';
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.blocked = true;
        this.error = 'External MCP access store is unreadable. Existing data was preserved.';
      }
      this.clients = [];
    }
    this.saved = JSON.stringify(this.clients);
    this.requests = new AccessRequests(home);
  }

  private write(path: string, data: unknown): void {
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }
  private save(): void {
    try {
      if (this.blocked) throw new Error(this.error);
      this.write(this.file, this.clients);
    } catch (error) {
      this.clients = JSON.parse(this.saved);
      throw error;
    }
    this.saved = JSON.stringify(this.clients);
    this.emit('changed');
  }
  private expire(): void {
    let changed = false;
    for (const c of this.clients) {
      if (c.status === 'pending' && (c.expiresAt ?? 0) <= Date.now()) {
        c.status = 'expired';
        changed = true;
      }
      if (c.pairing?.state === 'pending' && c.pairing.expiresAt <= Date.now()) {
        c.pairing.state = 'expired';
        changed = true;
      }
    }
    if (changed) this.save();
  }
  status(): ExternalMcpStatus {
    this.expire();
    const projects: string[] = [];
    for (const path of this.projectRoots()) {
      try {
        const root = realpathSync(path);
        if (!projects.includes(root)) projects.push(root);
      } catch {
        /* removed */
      }
    }
    const staleProjects: string[] = [];
    for (const client of this.clients)
      for (const path of client.projects) {
        if (!existsSync(path) && !staleProjects.includes(path)) staleProjects.push(path);
      }
    return {
      endpoint: this.endpoint,
      staleProjects,
      chatgptPlugin: this.chatgptPlugin,
      error: this.error,
      registered: this.registered,
      clients: this.clients.map(({ id, name, status, projects, lastSeenAt, capabilities }) => ({
        id,
        name,
        status,
        projects,
        capabilities: capabilities ?? {},
        connected: lastSeenAt !== undefined && Date.now() - lastSeenAt < 10_000,
      })),
      pending: this.clients
        .filter((c) => c.status === 'pending' || c.pairing?.state === 'pending')
        .map((c) =>
          c.pairing?.state === 'pending'
            ? {
                id: c.id,
                name: c.name,
                expiresAt: c.pairing.expiresAt,
                pairingCode: c.pairing.code,
              }
            : { id: c.id, name: c.name, expiresAt: c.expiresAt ?? 0 },
        ),
      projects,
      requests: this.requests.pending().map((r) => ({
        id: r.id,
        client: this.clients.find((c) => c.id === r.client_id)?.name ?? r.client_id,
        root: r.root,
        capabilities: r.capabilities,
        reason: r.reason,
        expiresAt: r.expires_at,
      })),
      ...(this.publicMcp ? { publicMcp: this.publicMcp } : {}),
    };
  }
  authenticate(header: string): Client | undefined {
    this.expire();
    const value = Buffer.from(header);
    return this.clients.find((c) => {
      const expected = Buffer.from(`Bearer ${c.token}`);
      return expected.length === value.length && timingSafeEqual(value, expected);
    });
  }
  attempt(header: string): Client['status'] | undefined {
    const client = this.authenticate(header);
    if (!client) return;
    client.lastSeenAt = Date.now();
    // An unanswered request is not a refusal: the next attempt re-arms it.
    if (client.status === 'registered' || client.status === 'expired') {
      client.status = 'pending';
      client.expiresAt = Date.now() + 5 * 60_000;
      this.save();
    }
    return client.status;
  }
  approved() {
    return this.clients
      .filter((c) => c.status === 'approved')
      .map((c) => ({ id: c.id, token: c.token, projects: [...c.projects] }));
  }
  decide(id: string, allow: boolean, projects: string[]): void {
    this.expire();
    const client = this.clients.find(
      (c) => c.id === id && (c.status === 'pending' || c.pairing?.state === 'pending'),
    );
    if (!client) throw new Error('Connection request expired or already handled.');
    const choices = this.status().projects;
    if (allow && (!projects.length || projects.some((p) => !choices.includes(p))))
      throw new Error('Select at least one available project.');
    if (client.pairing?.state === 'pending') client.pairing.state = allow ? 'approved' : 'denied';
    if (allow) {
      if (client.status !== 'approved') client.approvedAt = Date.now();
      client.projects = [...new Set(projects)];
      client.status = 'approved';
    } else if (client.status !== 'approved') {
      // Refusing a remote sign-in does not cut off a connection approved earlier.
      client.projects = [];
      client.status = 'denied';
    }
    this.save();
  }

  /** A remote sign-in asks the user in Ateam; the code ties the dialog to the web page. */
  requestPairing(id: string, name: string): string {
    this.expire();
    let client = this.clients.find((c) => c.id === id);
    if (client?.pairing?.state === 'pending') throw new Error('pairing_busy');
    if (!client) {
      client = {
        id,
        name,
        token: randomBytes(32).toString('hex'),
        status: 'registered',
        projects: [],
      };
      this.clients.push(client);
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    client.pairing = { code, expiresAt: Date.now() + PAIRING_MS, state: 'pending' };
    this.save();
    return code;
  }
  pairingState(id: string, code: string): Pairing['state'] | undefined {
    this.expire();
    const pairing = this.clients.find((c) => c.id === id)?.pairing;
    return pairing?.code === code ? pairing.state : undefined;
  }
  /** A tokenless client the sidecar vouches for (the relay channel); arms consent like attempt(). */
  touch(id: string, name: string): Client['status'] {
    this.expire();
    let client = this.clients.find((c) => c.id === id);
    if (!client) {
      client = {
        id,
        name,
        token: randomBytes(32).toString('hex'),
        status: 'registered',
        projects: [],
      };
      this.clients.push(client);
      this.save();
    }
    client.lastSeenAt = Date.now();
    if (client.status === 'registered' || client.status === 'expired') {
      client.status = 'pending';
      client.expiresAt = Date.now() + 5 * 60_000;
      this.save();
    }
    return client.status;
  }
  /** An approved client asks for a project folder and capabilities; the user decides in Ateam. */
  requestAccess(clientId: string, path: string, capabilities: Capability[], reason: string) {
    const client = this.clients.find((c) => c.id === clientId);
    if (!client || client.status !== 'approved') throw new Error('client_not_approved');
    const { root, error } = resolveProjectPath(path);
    if (!root) throw new Error(error ?? 'invalid_path');
    const have = client.capabilities?.[root] ?? [];
    if (client.projects.includes(root) && capabilities.every((c) => have.includes(c)))
      return { status: 'already_granted' as const, root, capabilities: have };
    const r = this.requests.create(clientId, root, capabilities, reason);
    this.emit('changed');
    return { request_id: r.id, status: r.status, root, capabilities: r.capabilities };
  }

  decideRequest(id: string, allow: boolean): void {
    const r = this.requests.decide(id, allow);
    const client = this.clients.find((c) => c.id === r.client_id);
    if (allow && client?.status === 'approved') {
      if (!client.projects.includes(r.root)) client.projects = [...client.projects, r.root];
      const have = client.capabilities?.[r.root] ?? [];
      client.capabilities = {
        ...(client.capabilities ?? {}),
        [r.root]: [...new Set([...have, ...r.capabilities])],
      };
      this.save();
    } else this.emit('changed');
  }

  /** The client's requests and what it holds now, for list_pending_authorizations. */
  authorizations(clientId: string) {
    const client = this.clients.find((c) => c.id === clientId);
    return {
      requests: this.requests.forClient(clientId).map(({ client_id: _c, ...r }) => r),
      granted: (client?.status === 'approved' ? client.projects : []).map((root) => ({
        root,
        capabilities: ['read', 'message', ...(client?.capabilities?.[root] ?? [])],
      })),
    };
  }

  /** Whether this client may perform `capability` in the project at `root`. */
  can(clientId: string, root: string, capability: Capability): boolean {
    const client = this.clients.find((c) => c.id === clientId);
    return (
      client?.status === 'approved' &&
      client.projects.includes(root) &&
      !!client.capabilities?.[root]?.includes(capability)
    );
  }

  /** Remote token check: the client is approved and the token postdates the approval. */
  grantValid(id: string, grantedAt: number): boolean {
    const client = this.clients.find((c) => c.id === id);
    if (!client || client.status !== 'approved') return false;
    client.lastSeenAt = Date.now();
    return grantedAt >= (client.approvedAt ?? 0);
  }
  revoke(id: string): void {
    const client = this.clients.find((c) => c.id === id);
    if (!client) throw new Error('Unknown client.');
    client.status = 'revoked';
    client.projects = [];
    client.pairing = undefined;
    client.capabilities = {};
    this.save();
  }
  retry(id: string): void {
    const client = this.clients.find((c) => c.id === id);
    if (!client || client.status === 'approved') throw new Error('Client cannot be paired again.');
    client.status = 'registered';
    client.projects = [];
    this.save();
  }

  /** Use the installed client's MCP manager so this appears in its actual MCP settings. */
  registerChatgpt(
    userHome: string,
    node: string,
    script: string,
    run: (args: string[]) => string = runChatgptMcp,
  ): { path: string; restartRequired: boolean; plugin?: ExternalMcpStatus['chatgptPlugin'] } {
    if (!existsSync(script) || !existsSync(node))
      throw new Error('Build the desktop connector before registration.');
    const path = join(process.env.CODEX_HOME || join(userHome, '.codex'), 'config.toml');
    const credential = join(this.home, 'external-mcp', 'chatgpt.json');
    const args = [script, '--credential', credential, '--home', this.home];
    const servers: {
      name: string;
      enabled: boolean;
      transport: { type: string; command?: string; args?: string[] };
    }[] = JSON.parse(run(['mcp', 'list', '--json']));
    if (!Array.isArray(servers)) throw new Error('Unable to read ChatGPT MCP configuration.');
    const old = servers.find((entry) => entry.name === 'ateam');
    if (old && (old.transport.type !== 'stdio' || !old.transport.args?.includes(credential)))
      throw new Error('An unrelated ateam MCP entry already exists in ChatGPT.');
    if (old && !old.enabled)
      throw new Error('Ateam MCP is disabled in the client; enable it in ChatGPT settings.');
    let client = this.clients.find((c) => c.id === 'chatgpt');
    if (!client) {
      client = {
        id: 'chatgpt',
        name: 'ChatGPT Desktop',
        token: randomBytes(32).toString('hex'),
        status: 'registered',
        projects: [],
      };
      this.clients.push(client);
      this.save();
    }
    this.write(credential, { token: client.token });
    const changed =
      !old ||
      old.transport.command !== node ||
      JSON.stringify(old.transport.args) !== JSON.stringify(args);
    if (changed) {
      if (existsSync(path))
        writeFileSync(`${path}.ateam-${Date.now()}-${randomUUID()}.bak`, readFileSync(path), {
          mode: 0o600,
          flag: 'wx',
        });
      run(['mcp', 'add', 'ateam', '--', node, ...args]);
    }
    const installed = JSON.parse(run(['mcp', 'get', 'ateam', '--json'])) as typeof old;
    if (
      !installed?.enabled ||
      installed.transport.command !== node ||
      JSON.stringify(installed.transport.args) !== JSON.stringify(args)
    )
      throw new Error('ChatGPT did not confirm the MCP registration.');
    this.chatgptPlugin = installChatgptPlugin({ home: this.home, node, script, run });
    this.error = this.chatgptPlugin.error;
    this.emit('changed');
    return {
      path,
      restartRequired: changed || this.chatgptPlugin.installed,
      plugin: this.chatgptPlugin,
    };
  }

  registerClaude(
    configPath: string,
    node: string,
    script: string,
  ): { path: string; restartRequired: boolean } {
    if (!existsSync(script) || !existsSync(node))
      throw new Error('Build the desktop connector before registration.');
    let config: Record<string, unknown> = {};
    let original: string | undefined;
    try {
      original = readFileSync(configPath, 'utf8');
      config = JSON.parse(original);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Claude Desktop configuration is invalid; it was not changed.');
    }
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('Invalid Claude Desktop configuration.');
    const servers = config.mcpServers ?? {};
    if (!servers || typeof servers !== 'object' || Array.isArray(servers))
      throw new Error('Invalid mcpServers configuration.');
    const map = servers as Record<string, unknown>;
    const credentialPath = join(this.home, 'external-mcp', 'claude-desktop.json');
    const entry = {
      command: node,
      args: [script, '--credential', credentialPath, '--home', this.home],
    };
    if (map.ateam && JSON.stringify(map.ateam) !== JSON.stringify(entry)) {
      const old = map.ateam as { args?: unknown[] };
      if (!Array.isArray(old.args) || !old.args.includes(credentialPath))
        throw new Error('An unrelated ateam MCP entry already exists.');
    }
    let client = this.clients.find((c) => c.id === 'claude-desktop');
    if (!client) {
      client = {
        id: 'claude-desktop',
        name: 'Claude Desktop',
        token: randomBytes(32).toString('hex'),
        status: 'registered',
        projects: [],
      };
      this.clients.push(client);
      this.save();
    }
    this.write(credentialPath, { token: client.token });
    const changed = JSON.stringify(map.ateam) !== JSON.stringify(entry);
    if (changed) {
      mkdirSync(dirname(configPath), { recursive: true });
      if (original !== undefined)
        writeFileSync(`${configPath}.ateam-${Date.now()}-${randomUUID()}.bak`, original, {
          mode: 0o600,
          flag: 'wx',
        });
      this.write(configPath, { ...config, mcpServers: { ...map, ateam: entry } });
    }
    this.registered = true;
    this.emit('changed');
    return { path: configPath, restartRequired: changed };
  }

  registerCursorDesktop(
    configPath: string,
    node: string,
    script: string,
  ): { path: string; restartRequired: boolean } {
    if (!existsSync(script) || !existsSync(node))
      throw new Error('Build the desktop connector before registration.');
    let config: Record<string, unknown> = {};
    let original: string | undefined;
    try {
      original = readFileSync(configPath, 'utf8');
      config = JSON.parse(original);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Cursor Desktop configuration is invalid; it was not changed.');
    }
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('Invalid Cursor Desktop configuration.');
    const servers = config.mcpServers ?? {};
    if (!servers || typeof servers !== 'object' || Array.isArray(servers))
      throw new Error('Invalid Cursor Desktop mcpServers configuration.');
    const map = servers as Record<string, unknown>;
    const credentialPath = join(this.home, 'external-mcp', 'cursor-desktop.json');
    const entry = {
      command: node,
      args: [script, '--credential', credentialPath, '--home', this.home],
    };
    if (map.ateam && JSON.stringify(map.ateam) !== JSON.stringify(entry)) {
      const old = map.ateam as { args?: unknown[] };
      if (!Array.isArray(old.args) || !old.args.includes(credentialPath))
        throw new Error('An unrelated ateam MCP entry already exists in Cursor Desktop.');
    }
    const changed = JSON.stringify(map.ateam) !== JSON.stringify(entry);
    let client = this.clients.find((c) => c.id === 'cursor-desktop');
    let existingCredential: unknown;
    let credentialExists = true;
    try {
      existingCredential = JSON.parse(readFileSync(credentialPath, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') credentialExists = false;
      else throw new Error('Cursor Desktop credential is invalid; it was not changed.');
    }
    if (
      credentialExists &&
      (!client ||
        !existingCredential ||
        typeof existingCredential !== 'object' ||
        !('token' in existingCredential) ||
        existingCredential.token !== client.token)
    )
      throw new Error('Cursor Desktop credential is invalid; it was not changed.');
    if (!client) {
      client = {
        id: 'cursor-desktop',
        name: 'Cursor Desktop',
        token: randomBytes(32).toString('hex'),
        status: 'registered',
        projects: [],
      };
      this.clients.push(client);
      this.save();
    }
    if (!credentialExists) this.write(credentialPath, { token: client.token });
    if (changed) {
      mkdirSync(dirname(configPath), { recursive: true });
      if (original !== undefined)
        writeFileSync(`${configPath}.ateam-${Date.now()}-${randomUUID()}.bak`, original, {
          mode: 0o600,
          flag: 'wx',
        });
      this.write(configPath, { ...config, mcpServers: { ...map, ateam: entry } });
    }
    this.registered = true;
    this.emit('changed');
    return { path: configPath, restartRequired: changed || !credentialExists };
  }
}

function runChatgptMcp(args: string[]): string {
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  const executable = existsSync(bundled) ? bundled : 'codex';
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      'ChatGPT MCP registration command failed. Check the installed client and its config.toml.',
    );
  }
}
