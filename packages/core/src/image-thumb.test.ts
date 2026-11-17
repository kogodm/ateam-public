import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pruneThumbCache, scaledLongEdge } from './image-thumb';

describe('scaledLongEdge', () => {
  it('sizes a tall contact sheet by its width, at most 6× the edge tall (color, 09-18)', () => {
    // 1280×8100: capping the long edge at 720 made it 114px wide
    const long = scaledLongEdge(1280, 8100, 720);
    expect(long).toBe(4320);
    expect(Math.round((1280 * long) / 8100)).toBe(683);
  });
  it('keeps an ordinary picture at the bubble width', () => {
    expect(scaledLongEdge(3000, 2000, 720)).toBe(720); // 720×480
    expect(scaledLongEdge(1170, 2532, 720)).toBe(1558); // 720×1558
  });
  it('never scales up', () => {
    expect(scaledLongEdge(400, 300, 720)).toBe(400);
  });
});

describe('pruneThumbCache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thumbs-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('drops copies unused for a week, then the least recently used past the cap', () => {
    const now = Date.now();
    const put = (name: string, kb: number, daysAgo: number) => {
      const p = join(dir, name);
      writeFileSync(p, Buffer.alloc(kb * 1024));
      const t = new Date(now - daysAgo * 86400_000);
      utimesSync(p, t, t);
    };
    put('stale.jpg', 10, 8);
    put('old.jpg', 40, 3);
    put('mid.jpg', 40, 2);
    put('new.jpg', 40, 0);
    writeFileSync(join(dir, 'notes.txt'), 'not a copy');
    const r = pruneThumbCache(dir, now, { maxBytes: 90 * 1024, force: true });
    expect(r.removed).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['mid.jpg', 'new.jpg', 'notes.txt']);
  });
});
