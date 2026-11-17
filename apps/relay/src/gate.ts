/**
 * The two rules that keep one machine's trouble from becoming another's.
 *
 * Pure, so both can be tested without a socket.
 */

/** What to do with a request that is otherwise cleared to reach a device. */
export type SsoDecision =
  /** cookie already matches — pass it through untouched */
  | 'proxy'
  /** navigation with a stale cookie — 302 back to itself carrying the fresh one */
  | 'redirect'
  /** not a navigation — attach the fresh cookie and pass through */
  | 'reissue'
  /** SSO cannot be established — serve OUR page, never the device's */
  | 'blocked';

/**
 * Whether a request may be proxied to the device.
 *
 * The rule that matters is `blocked`: the device's own LAN password page must
 * NEVER surface through the relay. It is the device's HTML, so it has no way
 * back to the machine picker — and a phone running the home-screen app has no
 * address bar either. Leaking it once strands the user on a machine they
 * cannot leave, which is how ONE machine flapping made the OTHER machine
 * unreachable too (2026-08-27: a duplicate desktop instance fought over one
 * device id, 6854 agent up/down in an hour, and the password page came
 * through in the gaps).
 *
 * So: no SSO pass from the device, or a cookie that will not converge after
 * one redirect, and we answer with our own page — which does have a way out.
 */
export function ssoDecision(args: {
  /** SSO pass this device reported on auth ('' = it reported none) */
  lanToken: string;
  /** the client's current ateam_lan cookie */
  cookie: string;
  method: string;
  /** this request already came back from an SSO redirect */
  retried: boolean;
}): SsoDecision {
  const { lanToken, cookie, method, retried } = args;
  if (!lanToken) return 'blocked';
  if (cookie === lanToken) return 'proxy';
  if (method === 'GET' || method === 'HEAD') return retried ? 'blocked' : 'redirect';
  return 'reissue';
}

/**
 * Two processes holding the same device token take turns kicking each other
 * off, and each one reconnects at once — a hot loop the relay cannot tell
 * from a machine with a bad network. Newer connections still win (a genuinely
 * stale entry must be replaceable), but a device that keeps replacing itself
 * is parked for a cooldown so the loop cannot run hot, whatever the desktop
 * on the other end believes.
 */
export class FlapGuard {
  private readonly hits = new Map<string, number[]>();
  private readonly parked = new Map<string, number>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 10_000,
    private readonly cooldownMs = 30_000,
  ) {}

  /** Called for every authenticated agent connection. False = refuse it. */
  accept(device: string, now: number): boolean {
    const until = this.parked.get(device) ?? 0;
    if (now < until) return false;
    const recent = (this.hits.get(device) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(device, recent);
    if (recent.length > this.limit) {
      this.parked.set(device, now + this.cooldownMs);
      this.hits.delete(device);
      return false;
    }
    return true;
  }

  /** ms until this device may connect again, 0 when it is free to. */
  parkedFor(device: string, now: number): number {
    return Math.max(0, (this.parked.get(device) ?? 0) - now);
  }
}

/** Marks a request as "already redirected once for SSO". A query param rather
 *  than another cookie: it is scoped to the one request, cannot outlive it,
 *  and is stripped again before the device ever sees it. */
export const SSO_RETRY_PARAM = '__ateam_sso';

export function markRetry(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${SSO_RETRY_PARAM}=1`;
}

export function hasRetryMark(url: string): boolean {
  const q = url.split('?')[1];
  return (
    !!q && q.split('&').some((kv) => kv === SSO_RETRY_PARAM || kv.startsWith(`${SSO_RETRY_PARAM}=`))
  );
}

/** Removes the mark, byte-for-byte preserving every other parameter — the
 *  device gets the request it would have got without us. (Re-serialising
 *  through URLSearchParams would re-encode the rest.) */
export function stripRetry(url: string): string {
  const [path, q] = url.split('?');
  if (!q) return url;
  const rest = q
    .split('&')
    .filter((kv) => kv !== SSO_RETRY_PARAM && !kv.startsWith(`${SSO_RETRY_PARAM}=`))
    .join('&');
  return rest ? `${path}?${rest}` : (path ?? '/');
}

/**
 * Whether a proxied request may be transparently retried on a FRESH tunnel
 * channel, and with what backoff.
 *
 * A dev server behind the tunnel answers a page with a burst of requests, and
 * under that burst the odd one comes back transient — a 502/503/504, or the
 * channel erroring before any response — while the very same request succeeds
 * a moment later (measured: entry-browser + fonts failed on the initial load,
 * then returned 200 on every retry). Retrying those masks the blip so a whole
 * page does not break because one module 503'd.
 *
 * Only safe when nothing has been written to the client yet (`headersSent`
 * false) and the method carries no body whose replay would be a second side
 * effect — GET/HEAD only. `status` is undefined for a transport error (the
 * channel closed with no response), which is always retryable.
 */
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const RETRY_BACKOFF_MS = [0, 150, 400] as const;

export function proxyRetry(args: {
  method: string | undefined;
  status: number | undefined;
  headersSent: boolean;
  attempt: number; // 1 for the first try
  maxAttempts: number;
}): { retry: false } | { retry: true; delayMs: number } {
  const { method, status, headersSent, attempt, maxAttempts } = args;
  if (headersSent || attempt >= maxAttempts) return { retry: false };
  const m = (method ?? 'GET').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return { retry: false };
  const transient = status === undefined || RETRYABLE_STATUS.has(status);
  if (!transient) return { retry: false };
  return { retry: true, delayMs: RETRY_BACKOFF_MS[attempt - 1] ?? 400 };
}

/** How many times an idempotent request may be attempted in total. */
export const PROXY_MAX_ATTEMPTS = 3;
