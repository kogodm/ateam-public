import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetFileSearchCache, scorePath, searchFiles } from './file-search';

describe('scorePath', () => {
  it('ranks a name match over a path match over scattered letters', () => {
    const name = scorePath('src/readme.md', 'read') ?? 0;
    const inPath = scorePath('readers/x.ts', 'read') ?? 0;
    const scattered = scorePath('r/e/a/d.ts', 'read') ?? 0;
    expect(name).toBeGreaterThan(scattered);
    expect(scorePath('docs/thread.md', 'read')).toBeGreaterThan(scattered);
    expect(inPath).toBeGreaterThan(scattered);
    expect(scorePath('src/app.ts', 'zzz')).toBeUndefined();
  });
});

describe('searchFiles (outside git: async walk)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ateam-filesearch-'));
    mkdirSync(join(dir, 'src/ui'), { recursive: true });
    mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'x');
    writeFileSync(join(dir, 'src/ui/App.tsx'), 'x');
    writeFileSync(join(dir, 'node_modules/pkg/app.js'), 'x');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => resetFileSearchCache());

  it('finds files and their directories, never inside node_modules', async () => {
    const hits = await searchFiles(dir, 'app');
    expect(hits).toContain('src/ui/App.tsx');
    expect(hits.some((h) => h.startsWith('node_modules'))).toBe(false);
    expect(await searchFiles(dir, 'ui')).toContain('src/ui/');
  });

  it('an empty query offers the shallow entries first', async () => {
    const hits = await searchFiles(dir, '');
    expect(hits[0]).toBe('README.md');
  });
});
