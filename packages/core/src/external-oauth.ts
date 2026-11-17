import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * OAuth 2.1 state for the public MCP endpoint (web connectors reach Ateam through a
 * Cloudflare Tunnel). Public clients only: PKCE S256, no client secrets. Tokens are
 * stored as SHA-256 hashes; consent itself lives in ExternalAccess (pairing).
 */

/** Web connectors we accept, mapped to the ExternalAccess client that holds the grant. */
const REDIRECT_HOSTS: Record<string, { id: string; name: string }> = {
  'chatgpt.com': { id: 'chatgpt-chat', name: 'ChatGPT (web connector)' },
  'chat.openai.com': { id: 'chatgpt-chat', name: 'ChatGPT (web connector)' },
  'platform.openai.com': { id: 'chatgpt-chat', name: 'ChatGPT (web connector)' },
  'claude.ai': { id: 'claude-web', name: 'Claude (web connector)' },
  'claude.com': { id: 'claude-web', name: 'Claude (web connector)' },
  'gemini.google.com': { id: 'gemini-web', name: 'Gemini (web connector)' },
  'aistudio.google.com': { id: 'gemini-web', name: 'Gemini (web connector)' },
  'vertexaisearch.cloud.google.com': { id: 'gemini-web', name: 'Gemini (web connector)' },
  'accounts.google.com': { id: 'gemini-web', name: 'Gemini (web connector)' },
  'oauth-redirect.googleusercontent.com': { id: 'gemini-web', name: 'Gemini (web connector)' },
  'oauth-redirect-sandbox.googleusercontent.com': {
    id: 'gemini-web',
    name: 'Gemini (web connector)',
  },
  'oauth-redirect-test.googleusercontent.com': {
    id: 'gemini-web',
    name: 'Gemini (web connector)',
  },
};

export const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const CODE_TTL_MS = 60_000;
const MAX_CLIENTS = 50;
const MAX_REDIRECT_URIS = 25;

export interface OAuthClient {
  redirectUris: string[];
  name: string;
  createdAt: number;
}
interface TokenRec {
  oauthClient: string;
  /** ExternalAccess client id */
  grantee: string;
  /** when the user approved the sign-in; carried through refresh rotation */
  grantedAt: number;
  expiresAt: number;
}
interface Stored {
  clients: Record<string, OAuthClient>;
  access: Record<string, TokenRec>;
  refresh: Record<string, TokenRec>;
}
interface CodeRec {
  oauthClient: string;
  redirectUri: string;
  challenge: string;
  grantee: string;
  grantedAt: number;
  expiresAt: number;
}
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

/** Extract `client_id` from an HTTP `Authorization: Basic ...` header (`client_secret_basic`). */
export function basicClientId(authorization?: string): string | undefined {
  const m = /^Basic\s+(.+)$/i.exec(authorization ?? '');
  if (!m) return undefined;
  try {
    const decoded = Buffer.from(m[1] as string, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const raw = colon >= 0 ? decoded.slice(0, colon) : decoded;
    return raw ? decodeURIComponent(raw) : undefined;
  } catch {
    return undefined;
  }
}

/** The grantee for a redirect URI, or undefined when the host is not an accepted connector. */
export function granteeFor(redirectUri: string): { id: string; name: string } | undefined {
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    const direct = REDIRECT_HOSTS[url.hostname];
    if (direct) return direct;
    if (
      /^oauth-redirect(-[a-z0-9-]+)?\.googleusercontent\.com$/i.test(url.hostname) ||
      url.hostname.endsWith('.gemini.google.com') ||
      url.hostname.endsWith('.google.com')
    ) {
      return { id: 'gemini-web', name: 'Gemini (web connector)' };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export class OAuthStore {
  private data: Stored;
  private readonly codes = new Map<string, CodeRec>();
  private readonly file: string;

  /** `file` holds registrations and token hashes (0600); the relay keeps its own. */
  constructor(file: string) {
    this.file = file;
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Stored;
      this.data = {
        clients: value.clients ?? {},
        access: value.access ?? {},
        refresh: value.refresh ?? {},
      };
    } catch {
      this.data = { clients: {}, access: {}, refresh: {} };
    }
  }

  private save(): void {
    const now = Date.now();
    const live = (m: Record<string, TokenRec>) =>
      Object.fromEntries(Object.entries(m).filter(([, t]) => t.expiresAt > now));
    this.data = { ...this.data, access: live(this.data.access), refresh: live(this.data.refresh) };
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** RFC 7591 dynamic registration, limited to known connector redirect hosts. */
  register(meta: {
    redirect_uris?: unknown;
    client_name?: unknown;
    token_endpoint_auth_method?: unknown;
  }): {
    client_id: string;
    client_secret?: string;
    client_secret_expires_at?: number;
    redirect_uris: string[];
    token_endpoint_auth_method: string;
  } {
    const uris = Array.isArray(meta.redirect_uris)
      ? meta.redirect_uris.filter((u): u is string => typeof u === 'string')
      : [];
    if (!uris.length || uris.length > MAX_REDIRECT_URIS || uris.some((u) => !granteeFor(u)))
      throw new OAuthError(
        'invalid_redirect_uri',
        'Only ChatGPT, Claude, and Gemini connectors may register.',
      );
    const name = typeof meta.client_name === 'string' ? meta.client_name.slice(0, 80) : 'connector';
    const authMethod =
      meta.token_endpoint_auth_method === 'client_secret_basic' ||
      meta.token_endpoint_auth_method === 'client_secret_post'
        ? meta.token_endpoint_auth_method
        : 'none';
    const entries = Object.entries(this.data.clients).sort(
      (a, b) => a[1].createdAt - b[1].createdAt,
    );
    const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_CLIENTS + 1)));
    const id = randomUUID();
    this.data = {
      ...this.data,
      clients: { ...kept, [id]: { redirectUris: uris, name, createdAt: Date.now() } },
    };
    this.save();
    return {
      client_id: id,
      ...(authMethod !== 'none'
        ? { client_secret: token(), client_secret_expires_at: 0 }
        : {}),
      redirect_uris: uris,
      token_endpoint_auth_method: authMethod,
    };
  }

  /** Validates an authorization request; returns who will hold the grant. */
  checkAuthorize(q: {
    client_id?: string;
    redirect_uri?: string;
    response_type?: string;
    code_challenge?: string;
    code_challenge_method?: string;
  }): { id: string; name: string } {
    const grantee = q.redirect_uri ? granteeFor(q.redirect_uri) : undefined;
    let client = q.client_id ? this.data.clients[q.client_id] : undefined;
    if (!client && q.client_id && q.redirect_uri && grantee?.id === 'gemini-web') {
      const entries = Object.entries(this.data.clients).sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
      );
      const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_CLIENTS + 1)));
      client = { redirectUris: [q.redirect_uri], name: grantee.name, createdAt: Date.now() };
      this.data = {
        ...this.data,
        clients: { ...kept, [q.client_id]: client },
      };
      this.save();
    }
    if (!client) throw new OAuthError('invalid_client', 'Unknown client. Re-add the connector.');
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
      if (
        grantee?.id === 'gemini-web' &&
        q.redirect_uri &&
        client.redirectUris.some((u) => granteeFor(u)?.id === 'gemini-web')
      ) {
        client.redirectUris = [...client.redirectUris, q.redirect_uri].slice(-MAX_REDIRECT_URIS);
        this.save();
      } else {
        throw new OAuthError('invalid_request', 'redirect_uri does not match the registration.');
      }
    }
    if (q.response_type !== 'code') throw new OAuthError('unsupported_response_type');
    if (grantee?.id === 'gemini-web') {
      if (q.code_challenge && q.code_challenge_method && q.code_challenge_method !== 'S256')
        throw new OAuthError('invalid_request', 'PKCE S256 is required.');
    } else if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      throw new OAuthError('invalid_request', 'PKCE S256 is required.');
    }
    return grantee as { id: string; name: string };
  }

  issueCode(rec: Omit<CodeRec, 'expiresAt'>): string {
    const code = token();
    this.codes.set(hash(code), { ...rec, expiresAt: Date.now() + CODE_TTL_MS });
    return code;
  }

  exchangeCode(p: {
    code?: string;
    code_verifier?: string;
    client_id?: string;
    redirect_uri?: string;
  }): TokenResponse {
    const key = hash(p.code ?? '');
    const rec = this.codes.get(key);
    this.codes.delete(key); // single use, even on failure
    if (!rec || rec.expiresAt <= Date.now()) throw new OAuthError('invalid_grant');
    if (rec.oauthClient !== p.client_id) throw new OAuthError('invalid_grant');
    if (rec.grantee === 'gemini-web') {
      if (p.redirect_uri && rec.redirectUri !== p.redirect_uri)
        throw new OAuthError('invalid_grant');
      if (rec.challenge) {
        const challenge = createHash('sha256')
          .update(p.code_verifier ?? '')
          .digest('base64url');
        if (!p.code_verifier || challenge !== rec.challenge) throw new OAuthError('invalid_grant');
      }
    } else {
      if (rec.redirectUri !== p.redirect_uri) throw new OAuthError('invalid_grant');
      const challenge = createHash('sha256')
        .update(p.code_verifier ?? '')
        .digest('base64url');
      if (!p.code_verifier || challenge !== rec.challenge) throw new OAuthError('invalid_grant');
    }
    return this.mint(rec.oauthClient, rec.grantee, rec.grantedAt);
  }

  /** Refresh tokens rotate; a reused one is rejected. */
  refresh(p: { refresh_token?: string; client_id?: string }): TokenResponse {
    const key = hash(p.refresh_token ?? '');
    const rec = this.data.refresh[key];
    if (
      !rec ||
      rec.expiresAt <= Date.now() ||
      (p.client_id !== undefined && rec.oauthClient !== p.client_id)
    )
      throw new OAuthError('invalid_grant');
    const { [key]: _used, ...rest } = this.data.refresh;
    this.data = { ...this.data, refresh: rest };
    return this.mint(rec.oauthClient, rec.grantee, rec.grantedAt);
  }

  private mint(oauthClient: string, grantee: string, grantedAt: number): TokenResponse {
    const access = token();
    const refresh = token();
    const now = Date.now();
    this.data = {
      ...this.data,
      access: {
        ...this.data.access,
        [hash(access)]: { oauthClient, grantee, grantedAt, expiresAt: now + ACCESS_TTL_S * 1000 },
      },
      refresh: {
        ...this.data.refresh,
        [hash(refresh)]: { oauthClient, grantee, grantedAt, expiresAt: now + REFRESH_TTL_MS },
      },
    };
    this.save();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
    };
  }

  /** The grant behind a bearer access token, if it is live. */
  verify(bearer: string): { grantee: string; grantedAt: number } | undefined {
    const m = /^Bearer (.+)$/.exec(bearer);
    const rec = m ? this.data.access[hash(m[1] as string)] : undefined;
    if (!rec || rec.expiresAt <= Date.now()) return undefined;
    return { grantee: rec.grantee, grantedAt: rec.grantedAt };
  }
}
