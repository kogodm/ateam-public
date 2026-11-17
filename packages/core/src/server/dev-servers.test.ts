import { describe, expect, it } from 'vitest';
import { INFRA_PORTS, isPreviewCandidate, isPreviewable } from './dev-servers';

describe('what may be offered for preview', () => {
  it('accepts an ordinary dev-server port', () => {
    expect(isPreviewCandidate(5173)).toBe(true);
    expect(isPreviewCandidate(8000)).toBe(true);
  });

  it('never offers a database, whatever it answers', () => {
    // exposing one through the relay would put it on the public internet
    // behind a single cookie
    for (const p of INFRA_PORTS) if (p >= 1024) expect(isPreviewCandidate(p)).toBe(false);
    expect(isPreviewCandidate(5432)).toBe(false);
  });

  it('skips our own listeners — tunnelling Ateam into Ateam is a loop', () => {
    expect(isPreviewCandidate(4380, [4380, 52468])).toBe(false);
    expect(isPreviewCandidate(52468, [4380, 52468])).toBe(false);
    expect(isPreviewCandidate(5173, [4380, 52468])).toBe(true);
  });

  it('leaves the privileged range alone', () => {
    // a dev server does not run on 80/443 without root, and anything that
    // does there is infrastructure we should not be re-publishing
    expect(isPreviewCandidate(80)).toBe(false);
    expect(isPreviewCandidate(443)).toBe(false);
    expect(isPreviewCandidate(1023)).toBe(false);
    expect(isPreviewCandidate(1024)).toBe(true);
  });

  it('rejects nonsense', () => {
    expect(isPreviewCandidate(70000)).toBe(false);
    expect(isPreviewCandidate(-1)).toBe(false);
    expect(isPreviewCandidate(1.5)).toBe(false);
  });
});

/** Measured on this machine: every local app with an HTTP listener answers
 *  something, and only the dev server answers OK with html. */
describe('telling a dev server from the rest of the machine', () => {
  it('accepts a dev server: OK and html', () => {
    expect(isPreviewable(200, 'text/html; charset=utf-8')).toBe(true);
    expect(isPreviewable(304, 'text/html')).toBe(true);
  });

  it('rejects the app noise it has to share the machine with', () => {
    expect(isPreviewable(200, '')).toBe(false); // QQ: a 200 with no type
    expect(isPreviewable(403, '')).toBe(false); // Control Center
    expect(isPreviewable(401, '')).toBe(false); // Pen
    expect(isPreviewable(404, 'text/html')).toBe(false); // QQMusic
    expect(isPreviewable(426, 'text/plain')).toBe(false); // a websocket endpoint
  });

  it('rejects an api that is not a page', () => {
    expect(isPreviewable(200, 'application/json')).toBe(false);
  });
});
