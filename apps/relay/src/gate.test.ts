import { describe, expect, it } from 'vitest';
import { FlapGuard, hasRetryMark, markRetry, proxyRetry, ssoDecision, stripRetry } from './gate';

const TOK = 'lan-pass-abc';

describe('may this request reach the device', () => {
  const ask = (o: Partial<Parameters<typeof ssoDecision>[0]>) =>
    ssoDecision({ lanToken: TOK, cookie: TOK, method: 'GET', retried: false, ...o });

  it('passes a request whose cookie already matches', () => {
    expect(ask({})).toBe('proxy');
  });

  it('redirects a navigation once, carrying the fresh cookie', () => {
    expect(ask({ cookie: 'stale' })).toBe('redirect');
  });

  it('BLOCKS a navigation whose cookie did not converge — the device password page must not surface', () => {
    expect(ask({ cookie: 'stale', retried: true })).toBe('blocked');
  });

  it('blocks whenever the device reported no SSO pass at all', () => {
    expect(ask({ lanToken: '', cookie: '' })).toBe('blocked');
    expect(ask({ lanToken: '', cookie: 'anything', retried: true })).toBe('blocked');
  });

  it('re-issues rather than redirecting for a non-navigation', () => {
    expect(ask({ cookie: 'stale', method: 'POST' })).toBe('reissue');
  });
});

describe('a device that keeps replacing itself', () => {
  it('lets an ordinary reconnect through', () => {
    const g = new FlapGuard();
    expect(g.accept('dev', 1000)).toBe(true);
    expect(g.accept('dev', 60_000)).toBe(true);
  });

  it('parks a device once it exceeds the limit inside the window', () => {
    const g = new FlapGuard(5, 10_000, 30_000);
    for (let i = 1; i <= 5; i++) expect(g.accept('dev', i * 500)).toBe(true);
    expect(g.accept('dev', 3000)).toBe(false); // 6th within 10s
    expect(g.parkedFor('dev', 3000)).toBe(30_000);
  });

  it('refuses every attempt while parked, then lets it back', () => {
    const g = new FlapGuard(2, 10_000, 30_000);
    g.accept('dev', 0);
    g.accept('dev', 100);
    expect(g.accept('dev', 200)).toBe(false); // parked until 30_200
    expect(g.accept('dev', 20_000)).toBe(false);
    expect(g.accept('dev', 30_300)).toBe(true);
  });

  it('parks the flapping device only, never its neighbour', () => {
    const g = new FlapGuard(2, 10_000, 30_000);
    for (let i = 0; i < 4; i++) g.accept('noisy', i * 100);
    expect(g.accept('noisy', 500)).toBe(false);
    expect(g.accept('quiet', 500)).toBe(true);
  });

  it('forgets hits that fall out of the window', () => {
    const g = new FlapGuard(2, 10_000, 30_000);
    g.accept('dev', 0);
    g.accept('dev', 1000);
    expect(g.accept('dev', 20_000)).toBe(true); // the first two aged out
  });
});

describe('the one-shot retry mark', () => {
  it('adds itself to a bare path and to one that already has a query', () => {
    expect(hasRetryMark(markRetry('/'))).toBe(true);
    expect(hasRetryMark(markRetry('/x?a=1'))).toBe(true);
  });

  it('is absent until added', () => {
    expect(hasRetryMark('/x?a=1')).toBe(false);
    expect(hasRetryMark('/')).toBe(false);
  });

  it('comes off again, leaving the rest untouched', () => {
    expect(stripRetry(markRetry('/x?a=1&b=hello%20there'))).toBe('/x?a=1&b=hello%20there');
    expect(stripRetry(markRetry('/'))).toBe('/');
  });

  it('does not mistake a parameter that merely starts alike', () => {
    expect(hasRetryMark('/x?__ateam_ssoish=1')).toBe(false);
    expect(stripRetry('/x?__ateam_ssoish=1')).toBe('/x?__ateam_ssoish=1');
  });
});

describe('may a proxied request be retried on a fresh channel', () => {
  const ask = (o: Partial<Parameters<typeof proxyRetry>[0]>) =>
    proxyRetry({
      method: 'GET',
      status: 503,
      headersSent: false,
      attempt: 1,
      maxAttempts: 3,
      ...o,
    });

  it('retries an idempotent GET that came back 502/503/504', () => {
    for (const status of [502, 503, 504]) {
      expect(ask({ status })).toEqual({ retry: true, delayMs: expect.any(Number) });
    }
  });

  it('retries when the channel errored before any response (no status)', () => {
    expect(ask({ status: undefined })).toMatchObject({ retry: true });
  });

  it('does NOT retry once bytes have gone to the client', () => {
    expect(ask({ headersSent: true })).toEqual({ retry: false });
  });

  it('does NOT retry a non-idempotent method — replay would be a second write', () => {
    expect(ask({ method: 'POST' })).toEqual({ retry: false });
    expect(ask({ method: 'DELETE', status: 503 })).toEqual({ retry: false });
  });

  it('does NOT retry a genuine 4xx/2xx — only transient upstream failures', () => {
    for (const status of [200, 304, 403, 404, 500]) {
      expect(ask({ status })).toEqual({ retry: false });
    }
  });

  it('stops at the attempt ceiling', () => {
    expect(ask({ attempt: 3, maxAttempts: 3 })).toEqual({ retry: false });
    expect(ask({ attempt: 2, maxAttempts: 3 })).toMatchObject({ retry: true });
  });

  it('backs off more on later attempts, starting immediately', () => {
    const first = ask({ attempt: 1 });
    const second = ask({ attempt: 2 });
    if (!first.retry || !second.retry) throw new Error('expected retries');
    expect(first.delayMs).toBe(0);
    expect(second.delayMs).toBeGreaterThan(first.delayMs);
  });
});
