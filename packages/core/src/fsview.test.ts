import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDir, firstExistingPath } from './fsview';

describe('firstExistingPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ateam-fsview-'));
  const real = join(dir, 'CHANGELOG.md');
  writeFileSync(real, '# changes\n');

  it('returns the first candidate that exists, skipping the missing ones', () => {
    const missing = join(dir, 'nope', 'CHANGELOG.md');
    expect(firstExistingPath([missing, real]).path).toBe(real);
  });

  it('picks the earliest existing candidate when several exist', () => {
    const other = join(dir, 'README.md');
    writeFileSync(other, 'hi\n');
    expect(firstExistingPath([real, other]).path).toBe(real);
  });

  it('returns null when none exist', () => {
    expect(firstExistingPath([join(dir, 'a.md'), join(dir, 'b.md')]).path).toBeNull();
  });

  it('ignores empty entries and expands ~', () => {
    expect(firstExistingPath(['', '~']).path).toBe(homedir());
  });
});

describe('createDir', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ateam-mkdir-'));

  it('creates a fresh directory under an existing parent', () => {
    const r = createDir(parent, 'my-app');
    expect(r).toEqual({ dir: join(parent, 'my-app'), created: true });
    expect(statSync(r.dir as string).isDirectory()).toBe(true);
  });

  it('reuses an existing directory instead of failing', () => {
    createDir(parent, 'twice');
    const r = createDir(parent, 'twice');
    expect(r.created).toBe(false);
    expect(r.dir).toBe(join(parent, 'twice'));
    expect(r.err).toBeUndefined();
  });

  it('refuses a name that is a file', () => {
    writeFileSync(join(parent, 'taken.txt'), 'x');
    const r = createDir(parent, 'taken.txt');
    expect(r.dir).toBeNull();
    expect(r.err).toContain('同名文件');
  });

  it('rejects path separators, dot names and empty input', () => {
    for (const bad of ['a/b', 'a\\b', '..', '.', '  ', '.hidden']) {
      const r = createDir(parent, bad);
      expect(r.dir, `should reject ${JSON.stringify(bad)}`).toBeNull();
      expect(r.err).toBeTruthy();
    }
  });

  it('rejects a missing or relative parent', () => {
    expect(createDir(join(parent, 'nope'), 'x').err).toBe('上级目录不存在');
    expect(createDir('relative/path', 'x').err).toBe('上级目录必须是绝对路径');
  });

  it('expands ~ in the parent', () => {
    const r = createDir('~', '.ateam-should-be-rejected');
    expect(r.err).toBeTruthy(); // dot-name rule still applies after expansion
  });
});
