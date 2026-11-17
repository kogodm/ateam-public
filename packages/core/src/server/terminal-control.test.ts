import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DistilledSkill, LearnedItem, LlmSynthesizer, ReflectionItem } from '@ateam/knowledge';
import { createInprocPair } from '@ateam/transport';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionManager } from '../session/manager';
import { RpcClient } from './rpc-client';
import { createServer } from './rpc-server';

class NoSynth implements LlmSynthesizer {
  reflect(): Promise<ReflectionItem[]> {
    return Promise.resolve([]);
  }
  learnFromRepo(): Promise<LearnedItem[]> {
    return Promise.resolve([]);
  }
  distillSkill(domain: string): Promise<DistilledSkill> {
    return Promise.resolve({ name: domain, domain, description: '', body: '', tags: [] });
  }
}

/**
 * A PTY has exactly ONE winsize, so a phone and a desktop attached to the same
 * session cannot both have it laid out for them. The rule: the layout belongs
 * to whoever is working in the session, and merely being connected changes
 * nothing — a phone that glanced at a session used to reflow the desktop to 40
 * columns and leave it that way, because the desktop never re-asserted.
 */
describe('terminal size ownership across clients', () => {
  let home: string;
  let prevHome: string | undefined;
  const SID = 'sess-1';

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-control-spec-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });

  afterAll(() => {
    // biome-ignore lint/performance/noDelete: unsetting an env var is the point
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** server + two attached clients, with every size that reaches the PTY recorded */
  function harness() {
    const sessions = new SessionManager();
    const applied: { cols: number; rows: number }[] = [];
    sessions.resize = (_id: string, cols: number, rows: number) => {
      applied.push({ cols, rows });
    };
    // no PTY in this suite — the policy under test is who gets to resize one
    sessions.input = () => ({});
    const server = createServer({ sessions, synth: new NoSynth(), storeRoot: home });
    const connect = () => {
      const { client, server: srv } = createInprocPair();
      server.attach(srv);
      return new RpcClient(client);
    };
    return { server, sessions, applied, desktop: connect(), phone: connect() };
  }

  it('the first client to measure a session claims it', async () => {
    const h = harness();
    await h.desktop.request('session.resize', { sessionId: SID, cols: 190, rows: 45 });
    expect(h.applied).toEqual([{ cols: 190, rows: 45 }]);
    h.server.shutdown();
  });

  it('a second client attaching does NOT reflow it', async () => {
    const h = harness();
    await h.desktop.request('session.resize', { sessionId: SID, cols: 190, rows: 45 });
    // the phone opens the app and its terminal reports its own tiny stage
    await h.phone.request('session.resize', { sessionId: SID, cols: 40, rows: 20 });
    expect(h.applied).toEqual([{ cols: 190, rows: 45 }]); // desktop still fits
    h.server.shutdown();
  });

  it('typing on the phone takes the layout, reflowing to the phone', async () => {
    const h = harness();
    await h.desktop.request('session.resize', { sessionId: SID, cols: 190, rows: 45 });
    await h.phone.request('session.resize', { sessionId: SID, cols: 40, rows: 20 });
    await h.phone.request('session.input', { sessionId: SID, data: 'hi' });
    expect(h.applied.at(-1)).toEqual({ cols: 40, rows: 20 });
    h.server.shutdown();
  });

  it('going back to the desktop takes it straight back', async () => {
    const h = harness();
    await h.desktop.request('session.resize', { sessionId: SID, cols: 190, rows: 45 });
    await h.phone.request('session.input', { sessionId: SID, data: 'hi' });
    await h.phone.request('session.resize', { sessionId: SID, cols: 40, rows: 20 });
    // clicking into the desktop terminal / returning to the window
    await h.desktop.request('session.activate', { sessionId: SID });
    expect(h.applied.at(-1)).toEqual({ cols: 190, rows: 45 });
    h.server.shutdown();
  });

  it('REGRESSION: a real resize takes the layout back — a drag is not a click', async () => {
    // Dragging the file-preview divider grew the desktop pane, but the phone
    // held the layout, so the PTY stayed narrow and the newly exposed columns
    // were painted by nobody: a blank band down the right that nothing could
    // recover, because a drag reaches no terminal and nothing else re-asserted.
    const h = harness();
    await h.desktop.request('session.resize', { sessionId: SID, cols: 190, rows: 45 });
    await h.phone.request('session.resize', { sessionId: SID, cols: 40, rows: 20 });
    await h.phone.request('session.input', { sessionId: SID, data: 'hi' }); // phone takes it
    expect(h.applied.at(-1)).toEqual({ cols: 40, rows: 20 });

    // the user drags the divider on the desktop — its pane genuinely changes
    await h.desktop.request('session.resize', { sessionId: SID, cols: 150, rows: 45 });
    expect(h.applied.at(-1)).toEqual({ cols: 150, rows: 45 });
    h.server.shutdown();
  });

  it('a client re-reporting the SAME size still does not take the layout', async () => {
    // panes re-report on every mount, tab switch and refit; only a change is
    // a person acting on that screen
    const h = harness();
    await h.desktop.request('session.resize', { sessionId: SID, cols: 190, rows: 45 });
    await h.phone.request('session.resize', { sessionId: SID, cols: 40, rows: 20 });
    await h.phone.request('session.input', { sessionId: SID, data: 'hi' });
    await h.desktop.request('session.resize', { sessionId: SID, cols: 190, rows: 45 }); // unchanged
    expect(h.applied.at(-1)).toEqual({ cols: 40, rows: 20 }); // phone keeps it
    h.server.shutdown();
  });

  it('tells each client whether the layout is now theirs', async () => {
    const h = harness();
    const seen: { who: string; youControl: boolean }[] = [];
    h.desktop.on('session.control', (d) =>
      seen.push({ who: 'desktop', youControl: (d as { youControl: boolean }).youControl }),
    );
    h.phone.on('session.control', (d) =>
      seen.push({ who: 'phone', youControl: (d as { youControl: boolean }).youControl }),
    );
    await h.desktop.request('session.resize', { sessionId: SID, cols: 190, rows: 45 });
    await h.phone.request('session.activate', { sessionId: SID });
    expect(seen).toContainEqual({ who: 'phone', youControl: true });
    expect(seen).toContainEqual({ who: 'desktop', youControl: false });
    h.server.shutdown();
  });

  it('a session whose owner disconnected is free for the next client', async () => {
    const h = harness();
    const { client, server: srv } = createInprocPair();
    h.server.attach(srv);
    const temp = new RpcClient(client);
    await temp.request('session.resize', { sessionId: SID, cols: 40, rows: 20 });
    expect(h.applied.at(-1)).toEqual({ cols: 40, rows: 20 });
    client.close(); // the phone goes away
    await new Promise((r) => setTimeout(r, 10));
    await h.desktop.request('session.resize', { sessionId: SID, cols: 190, rows: 45 });
    expect(h.applied.at(-1)).toEqual({ cols: 190, rows: 45 });
    h.server.shutdown();
  });
});
