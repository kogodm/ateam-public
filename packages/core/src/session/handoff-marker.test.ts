import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findHandoffMarker } from './handoff-marker';

const dir = mkdtempSync(join(tmpdir(), 'handoff-marker-'));
const doc = join(dir, 'savecats-handoff-2026-10-23.md');
writeFileSync(doc, 'x');

describe('findHandoffMarker', () => {
  it('reads a marker on one line', () => {
    expect(findHandoffMarker(`⏺ATEAM_HANDOFF_WRITTEN=${doc}\r✢Working`)).toBe(doc);
  });

  it('rejoins a marker wrapped over two rows', () => {
    const cut = doc.length - 20;
    expect(
      findHandoffMarker(`ATEAM_HANDOFF_WRITTEN=${doc.slice(0, cut)}\r\n  ${doc.slice(cut)}`),
    ).toBe(doc);
  });

  it('drops the redrawn text glued onto a wrapped path', () => {
    const cut = doc.length - 20;
    const screen = `ATEAM_HANDOFF_WRITTEN=${doc.slice(0, cut)}\r${doc.slice(cut)}Channeling…running`;
    expect(findHandoffMarker(screen)).toBe(doc);
  });

  it('ignores placeholders, relative paths and directories', () => {
    expect(findHandoffMarker('ATEAM_HANDOFF_WRITTEN=<path>')).toBeUndefined();
    expect(findHandoffMarker('ATEAM_HANDOFF_WRITTEN=docs/a.md')).toBeUndefined();
    expect(findHandoffMarker(`ATEAM_HANDOFF_WRITTEN=${dir}`)).toBeUndefined();
  });
});
