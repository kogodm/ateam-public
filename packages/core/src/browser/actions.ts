import { type Page, type Viewport, getViewport, setViewport, withPage } from './cdp';

/** What an agent can do in its tab. Every function takes the Ateam session id
 *  (its tab) and returns plain text or an image for the MCP layer to wrap. */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function evaluate<T>(page: Page, expression: string): Promise<T> {
  const r = await page.send<{
    result: { value?: T; description?: string };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value as T;
}

async function settle(page: Page): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await evaluate<string>(page, 'document.readyState')) === 'complete') return;
    } catch {
      /* mid-navigation */
    }
    await sleep(250);
  }
}

const SNAPSHOT_JS = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    if (!(r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none')) return false;
    for (let p = e; p; p = p.parentElement) if (parseFloat(getComputedStyle(p).opacity) === 0) return false;
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true;
    const top = document.elementFromPoint(x, y);
    return !!top && (e === top || e.contains(top) || top.contains(e)); };
  document.querySelectorAll('[data-ateam-i]').forEach((e) => e.removeAttribute('data-ateam-i'));
  const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],[contenteditable=true]';
  const els = [...document.querySelectorAll(sel)].filter(vis).slice(0, 150);
  const items = els.map((e, i) => { e.setAttribute('data-ateam-i', String(i));
    const label = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const kind = e.tagName.toLowerCase() + (e.type && e.tagName === 'INPUT' ? ':' + e.type : '');
    return '[' + i + '] ' + kind + (label ? ' "' + label + '"' : '') + (e.href ? ' -> ' + e.href.slice(0, 100) : ''); });
  return { url: location.href, title: document.title,
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000), items };
})()`;

export async function navigate(sessionId: string, url: string): Promise<string> {
  const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  return withPage(sessionId, async (page) => {
    await page.send('Page.enable');
    const r = await page.send<{ errorText?: string }>('Page.navigate', { url: target });
    if (r.errorText) throw new Error(`Could not open ${target}: ${r.errorText}`);
    await settle(page);
    return snapshotOf(page);
  });
}

async function snapshotOf(page: Page): Promise<string> {
  const s = await evaluate<{ url: string; title: string; text: string; items: string[] }>(
    page,
    SNAPSHOT_JS,
  );
  return [
    `URL: ${s.url}`,
    `Title: ${s.title}`,
    '',
    s.text,
    '',
    s.items.length
      ? `Interactive elements (use the number with browser_click / browser_type):\n${s.items.join('\n')}`
      : 'No interactive elements.',
  ].join('\n');
}

export function snapshot(sessionId: string): Promise<string> {
  return withPage(sessionId, snapshotOf);
}

export interface ShotOptions {
  /** a region in page pixels; the picture is re-rendered at `scale`, not stretched */
  clip?: { x: number; y: number; width: number; height: number };
  scale?: number;
}

export async function screenshot(sessionId: string, opts: ShotOptions = {}): Promise<string> {
  return withPage(sessionId, async (page) => {
    const { data } = await page.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      ...(opts.clip ? { clip: { ...opts.clip, scale: opts.scale ?? 1 } } : {}),
    });
    return data;
  });
}

/** Screen sizes by name: width x height are CSS pixels, the shot is that times scale. */
export const VIEWPORT_PRESETS = {
  'iphone-6.9': { width: 440, height: 956, scale: 3, mobile: true }, // 1320x2868
  'iphone-6.7': { width: 430, height: 932, scale: 3, mobile: true }, // 1290x2796
  'iphone-6.5': { width: 428, height: 926, scale: 3, mobile: true }, // 1284x2778
  'iphone-6.5-old': { width: 414, height: 896, scale: 3, mobile: true }, // 1242x2688
  'iphone-6.1': { width: 393, height: 852, scale: 3, mobile: true }, // 1179x2556
  'iphone-5.5': { width: 414, height: 736, scale: 3, mobile: true }, // 1242x2208
  'ipad-13': { width: 1032, height: 1376, scale: 2, mobile: true }, // 2064x2752
  'ipad-12.9': { width: 1024, height: 1366, scale: 2, mobile: true }, // 2048x2732
  'ipad-11': { width: 834, height: 1194, scale: 2, mobile: true }, // 1668x2388
  desktop: { width: 1280, height: 800, scale: 1, mobile: false },
} as const;

export type ViewportPreset = keyof typeof VIEWPORT_PRESETS;

/** Resize the tab like a device. Without arguments, back to the window size. */
export async function viewport(
  sessionId: string,
  vp: Pick<Viewport, 'width' | 'height'> & Partial<Pick<Viewport, 'scale' | 'mobile'>>,
): Promise<string> {
  const next: Viewport = {
    width: Math.round(vp.width),
    height: Math.round(vp.height),
    scale: vp.scale ?? 1,
    mobile: vp.mobile ?? false,
  };
  await withPage(sessionId, async () => undefined); // make sure the tab exists
  setViewport(sessionId, next);
  await withPage(sessionId, async (page) => {
    // let the page re-layout for the new size before the next look
    await evaluate(page, 'new Promise((r) => setTimeout(r, 300))');
  });
  return `Viewport ${next.width}x${next.height} at ${next.scale}x${next.mobile ? ' (mobile)' : ''}: screenshots are ${next.width * next.scale}x${next.height * next.scale} px.`;
}

export function resetViewport(sessionId: string): string {
  setViewport(sessionId, undefined);
  return 'Viewport back to the browser window size.';
}

export function currentViewport(sessionId: string): Viewport | undefined {
  return getViewport(sessionId);
}

async function centerOf(page: Page, index: number): Promise<{ x: number; y: number }> {
  const at = await evaluate<{ x: number; y: number; covered: string } | null>(
    page,
    `(() => { const e = document.querySelector('[data-ateam-i="${index}"]'); if (!e) return null;
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const top = document.elementFromPoint(x, y);
      const covered = top && !(e === top || e.contains(top) || top.contains(e));
      return { x, y, covered: covered ? (top.tagName.toLowerCase() + (top.className && typeof top.className === 'string' ? '.' + top.className.trim().split(/\\s+/)[0] : '')) : '' }; })()`,
  );
  if (!at) throw new Error(`No element [${index}] — take a new browser_snapshot, the page changed`);
  if (at.covered)
    throw new Error(
      `Element [${index}] is covered by <${at.covered}> and would not receive the click. Click its on-screen position with x and y instead.`,
    );
  return at;
}

async function clickAt(page: Page, x: number, y: number): Promise<void> {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
}

export function click(sessionId: string, index: number): Promise<string> {
  return withPage(sessionId, async (page) => {
    const { x, y } = await centerOf(page, index);
    await clickAt(page, x, y);
    await sleep(600);
    await settle(page);
    return snapshotOf(page);
  });
}

export function clickXY(sessionId: string, x: number, y: number): Promise<string> {
  return withPage(sessionId, async (page) => {
    await clickAt(page, x, y);
    await sleep(600);
    await settle(page);
    return snapshotOf(page);
  });
}

export function type(
  sessionId: string,
  index: number,
  text: string,
  submit: boolean,
): Promise<string> {
  return withPage(sessionId, async (page) => {
    const { x, y } = await centerOf(page, index);
    await clickAt(page, x, y);
    await evaluate(
      page,
      'document.activeElement && document.activeElement.select && document.activeElement.select()',
    );
    await page.send('Input.insertText', { text });
    if (submit) await press(page, 'Enter');
    await sleep(600);
    await settle(page);
    return snapshotOf(page);
  });
}

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
};

async function press(page: Page, name: string): Promise<void> {
  const k = KEYS[name];
  if (!k) throw new Error(`Unknown key "${name}". Known: ${Object.keys(KEYS).join(', ')}`);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk };
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...base,
    ...(k.text ? { text: k.text } : {}),
  });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export function pressKey(sessionId: string, name: string): Promise<string> {
  return withPage(sessionId, async (page) => {
    await press(page, name);
    await sleep(400);
    return snapshotOf(page);
  });
}

export function scroll(sessionId: string, dy: number): Promise<string> {
  return withPage(sessionId, async (page) => {
    await evaluate(page, `window.scrollBy(0, ${Math.round(dy)})`);
    await sleep(300);
    return snapshotOf(page);
  });
}

export function evalJs(sessionId: string, expression: string): Promise<string> {
  return withPage(sessionId, async (page) => {
    const value = await evaluate<unknown>(page, expression);
    return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'undefined');
  });
}
