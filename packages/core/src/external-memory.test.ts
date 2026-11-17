import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMemory, recordMemory, slugify, upsertIndexLine } from './external-memory';
import { humanMetaDir } from './human-meta';

let home: string;
let prev: string | undefined;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ateam-memory-'));
  prev = process.env.ATEAM_HOME;
  process.env.ATEAM_HOME = home;
});
afterAll(() => {
  if (prev === undefined) delete process.env.ATEAM_HOME;
  else process.env.ATEAM_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe('meta index lines', () => {
  const index = '# coder — 知识索引\n_updated: 2026-01-01_\n\n## Skills\n- **build** — ship it\n\n## Knowledge\n- **old** — before\n\n## Experiences\n- **e1** — first\n';
  it('adds under the right section, replaces the same entry, keeps the rest', () => {
    const a = upsertIndexLine(index, 'knowledge', 'new-note', 'fresh', 'coder');
    expect(a).toContain('- **old** — before\n- **new-note** — fresh\n\n## Experiences');
    expect(a).not.toContain('2026-01-01');
    const b = upsertIndexLine(a, 'knowledge', 'new-note', 'changed', 'coder');
    expect(b.match(/new-note/g)).toHaveLength(1);
    expect(b).toContain('- **new-note** — changed');
    expect(upsertIndexLine(index, 'experience', 'e2', 'second', 'coder')).toMatch(/- \*\*e1\*\* — first\n- \*\*e2\*\* — second\n$/);
  });
  it('creates the section or the whole index when missing', () => {
    expect(upsertIndexLine('# x\n', 'experience', 'e', 's', 'x')).toBe('# x\n\n## Experiences\n- **e** — s\n');
    expect(upsertIndexLine('', 'knowledge', 'k', 's', 'Coder')).toMatch(/^# Coder — knowledge index\n_updated: .*_\n\n## Knowledge\n- \*\*k\*\* — s\n$/);
  });
  it('keeps non-Latin names', () => {
    expect(slugify('广告回调 修复 v2')).toBe('广告回调-修复-v2');
    expect(slugify('!!!')).toBe('');
  });
});

describe('record and read', () => {
  const human = { id: 'h-1', name: 'Coder' };
  it('writes the note and its index line, and reads both back', () => {
    const r = recordMemory(
      human,
      { kind: 'experience', name: 'Ad callback race', summary: 'reward fired twice on resume', content: 'Lesson: guard with a flag. token=sk-abcdefghijklmnopqrstu' },
      'relay',
    );
    expect(r.path).toBe('experiences/ad-callback-race.md');
    const file = readFileSync(join(humanMetaDir('h-1'), r.path), 'utf8');
    expect(file).toContain('source: external MCP (relay)');
    expect(file).not.toContain('sk-abcdefghijklmnopqrstu');
    const mem = readMemory('h-1', 'Coder');
    expect(mem).toMatchObject({ human: 'Coder' });
    expect('index' in mem && mem.index).toContain('- **ad-callback-race** — reward fired twice on resume');
    expect('entries' in mem && mem.entries).toContainEqual({ kind: 'experience', name: 'ad-callback-race' });
    const one = readMemory('h-1', 'Coder', 'ad-callback-race');
    expect('text' in one && one.text).toContain('guard with a flag');
  });
  it('replaces only its own notes, and only when asked', () => {
    const note = { kind: 'knowledge' as const, name: 'build', summary: 's', content: 'v1' };
    recordMemory(human, note, 'relay');
    expect(() => recordMemory(human, note, 'relay')).toThrow('already exists');
    recordMemory(human, { ...note, content: 'v2', update: true }, 'relay');
    expect(readFileSync(join(humanMetaDir('h-1'), 'knowledge', 'build.md'), 'utf8')).toContain('v2');
    mkdirSync(join(humanMetaDir('h-1'), 'knowledge'), { recursive: true });
    writeFileSync(join(humanMetaDir('h-1'), 'knowledge', 'own.md'), 'written by the Human');
    expect(() => recordMemory(human, { ...note, name: 'own', update: true }, 'relay')).toThrow('itself');
  });
});
