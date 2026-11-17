import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ateamHome } from '../paths';

/**
 * The browser Ateam hands its sessions. One headless Chrome per machine, one
 * tab per Ateam session, driven over the DevTools protocol. Nothing here holds
 * a connection open: each call opens the tab's socket, does its work and
 * closes it, so the per-session MCP children and the sidecar (which paints the
 * stream's live view) all share the same Chrome without coordinating.
 */

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export function chromeBinary(): string | undefined {
  return process.env.ATEAM_CHROME ?? CHROME_PATHS.find((p) => existsSync(p));
}

function browserDir(): string {
  const dir = join(ateamHome(), 'browser');
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface ChromeState {
  pid: number;
  port: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function json<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`DevTools ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

async function alive(port: number): Promise<boolean> {
  try {
    await json(port, '/json/version');
    return true;
  } catch {
    return false;
  }
}

function readState(): ChromeState | undefined {
  try {
    return JSON.parse(readFileSync(join(browserDir(), 'state.json'), 'utf8')) as ChromeState;
  } catch {
    return undefined;
  }
}

let starting: Promise<number> | undefined;

/** The DevTools port of the shared Chrome, starting it when it is not running. */
export function ensureChrome(): Promise<number> {
  starting ??= startChrome().finally(() => {
    starting = undefined;
  });
  return starting;
}

async function startChrome(): Promise<number> {
  const known = readState();
  if (known && (await alive(known.port))) return known.port;
  const bin = chromeBinary();
  if (!bin)
    throw new Error(
      'No Chrome found. Install Google Chrome, or set ATEAM_CHROME to a Chromium binary.',
    );
  const profile = join(browserDir(), 'profile');
  mkdirSync(profile, { recursive: true });
  const portFile = join(profile, 'DevToolsActivePort');
  try {
    writeFileSync(portFile, '');
  } catch {
    /* Chrome rewrites it */
  }
  const child = spawn(
    bin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const [port] = (existsSync(portFile) ? readFileSync(portFile, 'utf8') : '').split('\n');
    const n = Number(port);
    if (n > 0 && (await alive(n))) {
      writeFileSync(
        join(browserDir(), 'state.json'),
        JSON.stringify({ pid: child.pid ?? 0, port: n }),
      );
      return n;
    }
  }
  throw new Error('Chrome did not open its DevTools port');
}

/** Stop the shared Chrome (the app is quitting). */
export function closeChrome(): void {
  const state = readState();
  if (!state?.pid) return;
  try {
    process.kill(state.pid);
  } catch {
    /* already gone */
  }
}

interface TargetInfo {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

function targetFile(sessionId: string): string {
  const dir = join(browserDir(), 'tabs');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/[^A-Za-z0-9-]/g, '_')}.json`);
}

/** This session's tab, opening one when it has none (or the user's Chrome lost it). */
async function sessionTarget(
  port: number,
  sessionId: string,
  create: boolean,
): Promise<TargetInfo | undefined> {
  const list = await json<TargetInfo[]>(port, '/json/list');
  let id: string | undefined;
  try {
    id = (JSON.parse(readFileSync(targetFile(sessionId), 'utf8')) as { id: string }).id;
  } catch {
    /* no tab yet */
  }
  const found = list.find((t) => t.id === id && t.type === 'page');
  if (found || !create) return found;
  const keep = { viewport: readTab(sessionId)?.viewport };
  const made = await json<TargetInfo>(port, '/json/new?about:blank', { method: 'PUT' });
  writeFileSync(targetFile(sessionId), JSON.stringify({ id: made.id, ...keep }));
  return made;
}

export interface Viewport {
  width: number;
  height: number;
  /** device pixel ratio: a 440x956 viewport at 3 shoots 1320x2868 */
  scale: number;
  mobile: boolean;
}

interface TabRecord {
  id: string;
  viewport?: Viewport;
}

function readTab(sessionId: string): TabRecord | undefined {
  try {
    return JSON.parse(readFileSync(targetFile(sessionId), 'utf8')) as TabRecord;
  } catch {
    return undefined;
  }
}

/** The size this session asked for, if any. */
export function getViewport(sessionId: string): Viewport | undefined {
  return readTab(sessionId)?.viewport;
}

/** Remember a viewport for the session's tab (undefined = back to the window size). */
export function setViewport(sessionId: string, viewport: Viewport | undefined): void {
  const rec = readTab(sessionId);
  if (!rec) return;
  writeFileSync(targetFile(sessionId), JSON.stringify({ id: rec.id, viewport }));
}

/** An emulated size lives only as long as the socket that set it, so every
 *  call re-applies the session's choice right after connecting. */
async function applyViewport(page: Page, viewport: Viewport | undefined): Promise<void> {
  if (!viewport) return;
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.scale,
    mobile: viewport.mobile,
  });
  if (viewport.mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
}

/** One request/response conversation with a tab. */
export class Page {
  private seq = 0;
  private readonly waiting = new Map<
    number,
    { ok: (v: unknown) => void; fail: (e: Error) => void }
  >();
  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id === undefined) return;
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.fail(new Error(msg.error.message));
      else w.ok(msg.result);
    });
    ws.on('close', () => {
      for (const w of this.waiting.values()) w.fail(new Error('The tab closed'));
      this.waiting.clear();
    });
  }

  static open(url: string): Promise<Page> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      ws.once('open', () => resolve(new Page(ws)));
      ws.once('error', reject);
    });
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((ok, fail) => {
      this.waiting.set(id, { ok: ok as (v: unknown) => void, fail });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.delete(id)) fail(new Error(`${method} timed out`));
      }, 30000);
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** Run `fn` against the session's tab; the socket is closed afterwards. */
export async function withPage<T>(sessionId: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const port = await ensureChrome();
  const target = await sessionTarget(port, sessionId, true);
  if (!target) throw new Error('Could not open a tab');
  const page = await Page.open(target.webSocketDebuggerUrl);
  try {
    await applyViewport(page, getViewport(sessionId));
    return await fn(page);
  } finally {
    page.close();
  }
}

export interface Shot {
  base64: string;
  url: string;
  title: string;
  at: number;
}

/** A JPEG of what the session's tab shows now, or undefined when it has no tab.
 *  Never starts Chrome — the live view must not wake a browser nobody asked for. */
export async function peekShot(sessionId: string, width = 960): Promise<Shot | undefined> {
  const state = readState();
  if (!state || !(await alive(state.port))) return undefined;
  const target = await sessionTarget(state.port, sessionId, false);
  if (!target) return undefined;
  const page = await Page.open(target.webSocketDebuggerUrl);
  try {
    const vp = getViewport(sessionId);
    await applyViewport(page, vp);
    const w = vp?.width ?? 1280;
    const h = vp?.height ?? 800;
    const { data } = await page.send<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 60,
      clip: { x: 0, y: 0, width: w, height: h, scale: Math.min(1, width / w) / (vp?.scale ?? 1) },
    });
    return { base64: data, url: target.url, title: target.title, at: Date.now() };
  } finally {
    page.close();
  }
}

/** Close the session's tab (it ended). */
export async function closeSessionTab(sessionId: string): Promise<void> {
  const state = readState();
  if (!state || !(await alive(state.port))) return;
  const target = await sessionTarget(state.port, sessionId, false);
  if (target)
    await fetch(`http://127.0.0.1:${state.port}/json/close/${target.id}`).catch(() => undefined);
}
