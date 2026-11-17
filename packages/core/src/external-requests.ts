import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

/**
 * Project access requests from external MCP clients (`request_project_access`).
 * The client asks for a folder and capabilities; the user answers in Ateam. An
 * approval is per project and lasts until revoked — no further prompts for
 * those capabilities (the user's choice, 2026-10-14); every use is audited.
 */
export const CAPABILITIES = ['execute', 'git_commit', 'git_push', 'create_session'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface AccessRequest {
  id: string;
  client_id: string;
  root: string;
  capabilities: Capability[];
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  created_at: number;
  expires_at: number;
  decided_at?: number;
}

const REQUEST_TTL_MS = 24 * 3600_000;
const MAX_PENDING_PER_CLIENT = 5;
const KEEP = 200;

/** Folders a client may never be granted, however it asks. */
function forbiddenRoot(root: string, home: string): string | undefined {
  if (root === sep || root === home) return 'the whole home directory or disk cannot be a project';
  if (!relative(root, home).startsWith('..')) return 'a folder containing the home directory cannot be a project';
  for (const dir of ['.ssh', '.aws', '.gnupg', '.ateam', '.ateam-debug', '.config', 'Library'])
    if (!relative(join(home, dir), root).startsWith('..')) return `${dir} cannot be a project`;
  if (/^\/(System|etc|usr|bin|sbin|Library|private\/etc)(\/|$)/.test(root)) return 'system folders cannot be projects';
  return undefined;
}

/** `~/x`, absolute, or relative-to-home path → real directory, or an error message. */
export function resolveProjectPath(path: string, home = homedir()): { root?: string; error?: string } {
  const raw = path.trim();
  if (!raw || raw.includes('\0')) return { error: 'path is required' };
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : resolve(home, raw);
  let root: string;
  try {
    root = realpathSync(expanded);
  } catch {
    return { error: `no such folder: ${raw}` };
  }
  if (!statSync(root).isDirectory()) return { error: `not a folder: ${raw}` };
  const realHome = realpathSync(home);
  const bad = forbiddenRoot(root, realHome);
  return bad ? { error: bad } : { root };
}

export class AccessRequests {
  private list: AccessRequest[] = [];
  private readonly file: string;

  constructor(home: string) {
    this.file = join(home, 'external-mcp', 'access-requests.json');
    try {
      if (existsSync(this.file)) this.list = JSON.parse(readFileSync(this.file, 'utf8')) as AccessRequest[];
    } catch {
      this.list = [];
    }
    if (!Array.isArray(this.list)) this.list = [];
  }

  private save(): void {
    this.list = this.list.slice(-KEEP);
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.list, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private expire(): boolean {
    let changed = false;
    for (const r of this.list)
      if (r.status === 'pending' && r.expires_at <= Date.now()) {
        r.status = 'expired';
        changed = true;
      }
    if (changed) this.save();
    return changed;
  }

  create(clientId: string, root: string, capabilities: Capability[], reason: string): AccessRequest {
    this.expire();
    const caps = [...new Set(capabilities)].filter((c) => CAPABILITIES.includes(c));
    const open = this.list.filter((r) => r.client_id === clientId && r.status === 'pending');
    const same = open.find((r) => r.root === root);
    if (same) {
      same.capabilities = [...new Set([...same.capabilities, ...caps])];
      same.reason = reason || same.reason;
      this.save();
      return same;
    }
    if (open.length >= MAX_PENDING_PER_CLIENT) throw new Error('too_many_pending_requests');
    const now = Date.now();
    const request: AccessRequest = {
      id: randomUUID(),
      client_id: clientId,
      root,
      capabilities: caps,
      reason: reason.slice(0, 500),
      status: 'pending',
      created_at: now,
      expires_at: now + REQUEST_TTL_MS,
    };
    this.list.push(request);
    this.save();
    return request;
  }

  pending(): AccessRequest[] {
    this.expire();
    return this.list.filter((r) => r.status === 'pending');
  }

  forClient(clientId: string): AccessRequest[] {
    this.expire();
    return this.list.filter((r) => r.client_id === clientId).slice(-20);
  }

  decide(id: string, allow: boolean): AccessRequest {
    this.expire();
    const r = this.list.find((x) => x.id === id && x.status === 'pending');
    if (!r) throw new Error('Request expired or already handled.');
    r.status = allow ? 'approved' : 'denied';
    r.decided_at = Date.now();
    this.save();
    return r;
  }
}
