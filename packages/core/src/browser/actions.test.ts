import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  VIEWPORT_PRESETS,
  click,
  evalJs,
  navigate,
  screenshot,
  type as typeInto,
  viewport,
} from './actions';
import { chromeBinary, closeChrome, closeSessionTab, peekShot } from './cdp';

const page = `data:text/html,${encodeURIComponent(
  '<title>Probe</title><input id=n placeholder=name><button onclick="document.title=document.getElementById(\'n\').value">Go</button>',
)}`;
const home = mkdtempSync(join(tmpdir(), 'ateam-browser-'));

// needs a real Chrome; skipped on machines without one
describe.skipIf(!chromeBinary())('session browser', () => {
  beforeAll(() => {
    process.env.ATEAM_HOME = home;
  });
  afterAll(async () => {
    await closeSessionTab('t1');
    closeChrome();
    Reflect.deleteProperty(process.env, 'ATEAM_HOME');
    await new Promise((r) => setTimeout(r, 800)); // Chrome is still closing its profile
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  it('opens a page, types, clicks and paints its tab', async () => {
    const first = await navigate('t1', page);
    expect(first).toContain('Title: Probe');
    expect(first).toContain('input:text');
    const input = /\[(\d+)\] input/.exec(first)?.[1];
    const button = /\[(\d+)\] button "Go"/.exec(first)?.[1];
    await typeInto('t1', Number(input), 'Ada', false);
    await click('t1', Number(button));
    expect(await evalJs('t1', 'document.title')).toBe('Ada');
    const shot = await peekShot('t1', 320);
    expect(shot?.base64.length).toBeGreaterThan(500);
    expect(await peekShot('nobody')).toBeUndefined();
  }, 60000);

  it('shoots at device size and skips elements hidden behind others', async () => {
    const stacked = `data:text/html,${encodeURIComponent(
      '<title>Stack</title><button id=a>Back</button><div style="position:fixed;inset:0;background:#fff"><button id=b>Front</button></div>',
    )}`;
    const snap = await navigate('t2', stacked);
    expect(snap).toContain('"Front"');
    expect(snap).not.toContain('"Back"');
    await viewport('t2', { width: 440, height: 956, scale: 3, mobile: true });
    const png = Buffer.from(await screenshot('t2'), 'base64');
    expect(png.readUInt32BE(16)).toBe(1320);
    expect(png.readUInt32BE(20)).toBe(2868);
    await viewport('t2', { ...VIEWPORT_PRESETS['ipad-13'] });
    const pad = Buffer.from(await screenshot('t2'), 'base64');
    expect([pad.readUInt32BE(16), pad.readUInt32BE(20)]).toEqual([2064, 2752]);
    await closeSessionTab('t2');
  }, 60000);
});
