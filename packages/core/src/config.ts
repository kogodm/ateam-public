import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ateamHome } from './paths';

export interface RoleConfig {
  skillDir?: string;
  learnedProjects: string[];
}

/** Auto-handoff: when the active session's estimated token count crosses
 *  `thresholdTokens`, ask the agent to run the handoff skill (the mattpocock
 *  one) on its own conversation. Default 120K — Claude's effective working
 *  context is ~200K, so 120K leaves ~80K headroom for the handoff doc itself. */
export interface AutoHandoffConfig {
  enabled: boolean;
  thresholdTokens: number;
}

/** Past this many tokens a session is told, once, to write what it has
 *  learned into its knowledge folder — WITHOUT being replaced. Claude Code
 *  compacts on its own at the window minus a ~33K reserve (967K–1,000K on a
 *  1M window, 167K on a 200K one); a compaction keeps only a summary, so the
 *  lessons have to be written down before it, while the whole conversation
 *  is still in context. See docs/sessions/compaction-and-experience.md. */
export interface ExperienceCheckpointConfig {
  enabled: boolean;
  thresholdTokens: number;
}

/** App-level proxy: when enabled, every NEWLY spawned session gets
 *  HTTP_PROXY/HTTPS_PROXY (+ lowercase twins) set to `url` in its PTY
 *  environment, overriding whatever the login shell / process exported.
 *  Already-running PTYs keep the env they were spawned with. */
export interface ProxyConfig {
  enabled: boolean;
  url: string;
}

/** Idle-session auto-hibernation: a live claude process costs ~300MB
 *  whether or not anyone talks to it, so sessions quiet for longer than
 *  `idleHours` get their PTY killed (node stays, --resume wakes it). */
export interface HibernateConfig {
  enabled: boolean;
  idleHours: number;
}

/** LAN access: serve the desktop UI + the RPC socket on all interfaces so a
 *  phone or another machine on the same network can drive this Ateam.
 *
 *  OFF by default and password-gated by construction. The RPC surface spawns
 *  PTYs running claude with this user's full filesystem access — anyone who
 *  reaches it owns the machine — so the toggle refuses to turn on without a
 *  password, and only the scrypt hash + salt are ever stored. There is no
 *  "no password" mode on purpose. */
export interface LanConfig {
  enabled: boolean;
  port: number;
  /** scrypt hash of the password, hex; '' when never set (⇒ cannot enable) */
  passwordHash: string;
  /** random per-password salt, hex */
  passwordSalt: string;
}

/** Remote access through a self-hosted relay (apps/relay): the desktop dials
 *  OUT to the relay and tunnels the relay's public connections into the LAN
 *  server — so LAN access (with its password) must be on. The device token
 *  is a bearer secret for this machine's tunnel; stored as-is (it is what we
 *  must present), file is 0600 like the rest of config. */
export interface RemoteConfig {
  enabled: boolean;
  /** wss://host:port (the relay's agent endpoint, path /agent is implied) */
  url: string;
  deviceId: string;
  token: string;
  /** sha256 fingerprint of the relay's TLS cert (self-signed relays); '' =
   *  system trust store */
  tlsFingerprint: string;
  /** what this machine is called — the name sent at registration, which is
   *  what the phone's machine picker lists. '' until registered; the host
   *  name stands in. */
  name: string;
  /** the relay account this machine signed in with — the owner of everything
   *  it syncs. '' until signed in (or registered by a pre-sync relay). */
  accountId: string;
  email: string;
}

export type DesktopView = 'terminal' | 'stream';

export interface AteamConfig {
  version: 1;
  roles: Record<string, RoleConfig>;
  codegraph: boolean;
  /** Restore every saved session on connect WITHOUT the confirmation dialog.
   *  Exists for the headless restart flow (local package → app restarts →
   *  a phone connects and everything should just come back); the spawn-side
   *  resume dedup makes it safe for several clients to ask at once. */
  autoResume: boolean;
  /** Which view a session opens in on a desktop client — the terminal (the
   *  CLI's own screen) or the stream (transcript rendered as a chat). A phone
   *  always defaults to the stream. Per-session toggles still override it. */
  desktopView: DesktopView;
  autoHandoff: AutoHandoffConfig;
  experienceCheckpoint: ExperienceCheckpointConfig;
  proxy: ProxyConfig;
  hibernate: HibernateConfig;
  lan: LanConfig;
  remote: RemoteConfig;
  sync: SyncConfig;
}

/** Cross-device sync (docs/sync/design.md). Off until the user turns it on:
 *  while it is off Ateam writes nothing into their projects — an existing
 *  `.ateam/project.json` is still read, but none is created. */
export interface SyncConfig {
  enabled: boolean;
}
const DEFAULT_SYNC: SyncConfig = { enabled: false };

const DEFAULT_LAN: LanConfig = {
  enabled: false,
  port: 4380,
  passwordHash: '',
  passwordSalt: '',
};
/** The relay this build signs in to. Registration needs a base URL before the
 *  device knows anything, and asking the user to type one turned a two-field
 *  sign-in into a five-field form — so the address is baked in and hidden.
 *  A different relay is still reachable: whatever `remote.url` holds after a
 *  registration wins over this, so editing config.json re-points the machine. */
export const DEFAULT_RELAY_BASE_URL = 'https://relay.kidsmath.icu:27443';

const DEFAULT_REMOTE: RemoteConfig = {
  enabled: false,
  url: '',
  deviceId: '',
  token: '',
  tlsFingerprint: '',
  name: '',
  accountId: '',
  email: '',
};

/** What to call this machine, for a client that may have tunnelled in from
 *  anywhere. The name given at relay registration is the right one — it is
 *  what the phone's machine picker listed — and the host name stands in until
 *  a registration supplies it. */
export function machineName(c: AteamConfig): string {
  return c.remote.name.trim() || hostname();
}

/** A LAN password for someone who never chose one. Sign-in turns LAN access on
 *  because the tunnel feeds it, and LAN access refuses to run without a
 *  password by construction — so one is minted instead of prompting. Shown
 *  once, and replaceable in the LAN pane. */
export function generateLanPassword(): string {
  // base32-ish: no look-alike characters, readable over a phone call
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

const DEFAULT_AUTO_HANDOFF: AutoHandoffConfig = {
  enabled: true,
  // ~1M-token context models: hand off at 680K so the successor's first
  // turn + the handoff doc still have plenty of room to breathe.
  thresholdTokens: 680_000,
};

const DEFAULT_EXPERIENCE_CHECKPOINT: ExperienceCheckpointConfig = {
  enabled: true,
  // a 1M window compacts at ~967K: leave ~117K for the saving turn and for a
  // long turn that crosses the line between two sweeps
  thresholdTokens: 850_000,
};

// Clash / V2Ray's conventional local mixed port — prefilled so enabling the
// toggle "just works". Scheme-less on purpose: proxyEnv() derives http://
// for HTTP(S)_PROXY and socks5:// for ALL_PROXY from a bare host:port.
const DEFAULT_PROXY: ProxyConfig = { enabled: false, url: '127.0.0.1:7890' };

const DEFAULT_HIBERNATE: HibernateConfig = { enabled: true, idleHours: 24 };

function configFile(): string {
  return join(ateamHome(), 'config.json');
}

/** First run = config file absent (drives the setup wizard). */
export function isFirstRun(): boolean {
  return !existsSync(configFile());
}

export function loadConfig(): AteamConfig {
  try {
    const c = JSON.parse(readFileSync(configFile(), 'utf8')) as Partial<AteamConfig>;
    return {
      version: 1,
      roles: c.roles ?? {},
      codegraph: c.codegraph ?? true,
      autoResume: c.autoResume ?? true,
      desktopView: c.desktopView === 'stream' ? 'stream' : 'terminal',
      autoHandoff: { ...DEFAULT_AUTO_HANDOFF, ...(c.autoHandoff ?? {}) },
      experienceCheckpoint: {
        ...DEFAULT_EXPERIENCE_CHECKPOINT,
        ...(c.experienceCheckpoint ?? {}),
      },
      proxy: {
        enabled: c.proxy?.enabled ?? DEFAULT_PROXY.enabled,
        // blank url normalizes to the default so the Settings field never
        // presents empty (and enabled-with-blank still proxies somewhere
        // sane instead of silently doing nothing).
        url: c.proxy?.url?.trim() ? c.proxy.url : DEFAULT_PROXY.url,
      },
      hibernate: { ...DEFAULT_HIBERNATE, ...(c.hibernate ?? {}) },
      sync: { ...DEFAULT_SYNC, ...(c.sync ?? {}) },
      lan: { ...DEFAULT_LAN, ...(c.lan ?? {}) },
      remote: { ...DEFAULT_REMOTE, ...(c.remote ?? {}) },
    };
  } catch {
    return {
      version: 1,
      roles: {},
      codegraph: true,
      autoResume: true,
      desktopView: 'terminal',
      autoHandoff: DEFAULT_AUTO_HANDOFF,
      experienceCheckpoint: DEFAULT_EXPERIENCE_CHECKPOINT,
      lan: DEFAULT_LAN,
      remote: DEFAULT_REMOTE,
      proxy: DEFAULT_PROXY,
      hibernate: DEFAULT_HIBERNATE,
      sync: DEFAULT_SYNC,
    };
  }
}

/** Env vars implementing the app-level proxy for a spawned session.
 *  Empty when disabled or the URL is blank. Both spellings are set —
 *  claude reads HTTPS_PROXY; curl/git and friends inside the session
 *  read the lowercase twins. ALL_PROXY is set too so a shell profile's
 *  own `all_proxy=socks5://…` can't leak past the toggle.
 *
 *  A bare `host:port` fans out per protocol the way a typical Clash
 *  mixed-port shell setup does: http:// for HTTP(S)_PROXY (claude's URL
 *  parsing needs a scheme and handles socks poorly) and socks5:// for
 *  ALL_PROXY. An explicit scheme is respected verbatim everywhere.
 *
 *  NO_PROXY is always set to the loopback set so local MCP servers and
 *  services (a pencil server on 127.0.0.1:3100, etc.) are reached DIRECTLY.
 *  Without it, ALL_PROXY/HTTP_PROXY force 127.0.0.1 through the proxy and the
 *  proxy answers 502 "can't reach upstream" — env-var proxies ignore the OS
 *  proxy bypass list, so NO_PROXY is the only knob. */
export function proxyEnv(): Record<string, string> {
  const { proxy } = loadConfig();
  const url = proxy.url.trim();
  if (!proxy.enabled || !url) return {};
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
  const httpUrl = hasScheme ? url : `http://${url}`;
  const allUrl = hasScheme ? url : `socks5://${url}`;
  const noProxy = 'localhost,127.0.0.1,::1';
  return {
    HTTP_PROXY: httpUrl,
    HTTPS_PROXY: httpUrl,
    ALL_PROXY: allUrl,
    NO_PROXY: noProxy,
    http_proxy: httpUrl,
    https_proxy: httpUrl,
    all_proxy: allUrl,
    no_proxy: noProxy,
  };
}

export function saveConfig(c: AteamConfig): void {
  mkdirSync(ateamHome(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(c, null, 2));
}

export function recordRole(
  role: string,
  patch: { skillDir?: string; learnedProject?: string },
): void {
  const c = loadConfig();
  const r = c.roles[role] ?? { learnedProjects: [] };
  if (patch.skillDir) r.skillDir = patch.skillDir;
  if (patch.learnedProject && !r.learnedProjects.includes(patch.learnedProject)) {
    r.learnedProjects.push(patch.learnedProject);
  }
  c.roles[role] = r;
  saveConfig(c);
}

/** Persist (even empty) so the setup wizard won't nag on next launch. */
export function finishSetup(): void {
  saveConfig(loadConfig());
}

/** Hash a LAN password for storage. scrypt with a fresh random salt — the
 *  file sits in the user's home, but a stored plaintext password is one
 *  backup/screen-share away from being someone else's shell. */
/** Returns the LanConfig fields to spread into the config — keyed exactly as
 *  LanConfig stores them (a `{hash, salt}` shape once leaked in here and the
 *  password silently never saved, so LAN access could never be enabled). */
export function hashLanPassword(
  password: string,
): Pick<LanConfig, 'passwordHash' | 'passwordSalt'> {
  const passwordSalt = randomBytes(16).toString('hex');
  const passwordHash = scryptSync(password, passwordSalt, 32).toString('hex');
  return { passwordHash, passwordSalt };
}

/** Constant-time check of a candidate password against the stored hash.
 *  False whenever LAN access was never given a password — "no password set"
 *  must never read as "any password works". */
export function verifyLanPassword(cfg: LanConfig, candidate: string): boolean {
  if (!cfg.passwordHash || !cfg.passwordSalt || !candidate) return false;
  const want = Buffer.from(cfg.passwordHash, 'hex');
  const got = scryptSync(candidate, cfg.passwordSalt, want.length);
  return want.length === got.length && timingSafeEqual(want, got);
}
