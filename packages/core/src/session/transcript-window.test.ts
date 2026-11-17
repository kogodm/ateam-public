import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readWindowBefore } from './transcript-file';

const dir = mkdtempSync(join(tmpdir(), 'ateam-window-'));
const file = join(dir, 't.jsonl');
// 40 lines, each ~50 bytes
const LINES = Array.from({ length: 40 }, (_, i) => `{"n":${i},"pad":"${'x'.repeat(40)}"}`);
writeFileSync(file, `${LINES.join('\n')}\n`);
const SIZE = Buffer.byteLength(`${LINES.join('\n')}\n`);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readWindowBefore', () => {
  it('walks the file backwards a window at a time, never splitting a line', () => {
    const seen: number[] = [];
    let end = SIZE;
    let guard = 0;
    while (end > 0 && guard++ < 20) {
      const w = readWindowBefore(file, end, 300);
      // every line parses (no partial line leaked through)
      const ns = w.lines.map((l) => (JSON.parse(l) as { n: number }).n);
      seen.unshift(...ns);
      expect(w.fromByte).toBeLessThan(end);
      end = w.fromByte;
    }
    expect(end).toBe(0);
    // the whole file came back exactly once, in order
    expect(seen).toEqual(LINES.map((_, i) => i));
  });

  it('reports fromByte 0 when the window reaches the start', () => {
    const w = readWindowBefore(file, 200, 4096);
    expect(w.fromByte).toBe(0);
    expect(w.lines.length).toBeGreaterThan(0);
  });

  it('always makes progress, even across a record bigger than the window', () => {
    // one 5KB line in the middle: a 300-byte window lands entirely inside it
    const big = join(dir, 'big.jsonl');
    const body = `{"n":0}\n{"big":"${'y'.repeat(5000)}"}\n{"n":2}\n`;
    writeFileSync(big, body);
    let end = Buffer.byteLength(body);
    let guard = 0;
    while (end > 0 && guard++ < 60) {
      const w = readWindowBefore(big, end, 300);
      expect(w.fromByte).toBeLessThan(end); // never stalls
      end = w.fromByte;
    }
    expect(end).toBe(0);
    expect(guard).toBeLessThan(60);
  });

  it('is empty at the start of the file or for a missing file', () => {
    expect(readWindowBefore(file, 0, 4096).lines).toEqual([]);
    expect(readWindowBefore(join(dir, 'nope.jsonl'), 999, 4096).lines).toEqual([]);
  });
});
