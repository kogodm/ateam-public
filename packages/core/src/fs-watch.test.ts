import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsWatchHub } from './fs-watch';

describe('FsWatchHub', () => {
  let dir: string;
  let hub: FsWatchHub | undefined;

  afterEach(() => {
    hub?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('pushes a debounced change event; junk dirs are ignored; refcounts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ateam-fswatch-spec-'));
    mkdirSync(join(dir, 'node_modules'));
    const events: string[][] = [];
    hub = new FsWatchHub((_d, paths) => events.push(paths));

    expect(hub.watchDir(dir)).toBe(true);
    expect(hub.watchDir(dir)).toBe(true); // second ref, same watcher

    writeFileSync(join(dir, 'node_modules', 'junk.js'), 'x'); // must NOT emit
    writeFileSync(join(dir, 'real.txt'), 'hello');
    await new Promise((r) => setTimeout(r, 1500));

    expect(events.length).toBeGreaterThan(0);
    const all = events.flat();
    expect(all.some((p) => p.includes('real.txt'))).toBe(true);
    expect(all.some((p) => p.includes('junk.js'))).toBe(false);

    // one unwatch keeps the second ref alive; the next drops it
    hub.unwatchDir(dir);
    hub.unwatchDir(dir);
    const before = events.length;
    writeFileSync(join(dir, 'after.txt'), 'x');
    await new Promise((r) => setTimeout(r, 600));
    expect(events.length).toBe(before); // no watcher left → no event
  });
});
