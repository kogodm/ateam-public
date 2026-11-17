import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listSlashCommands } from './claude-commands';

const cwd = join(tmpdir(), `ateam-cmds-${process.pid}`);

afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe('listSlashCommands', () => {
  it('merges project commands over builtins, with namespacing and descriptions', () => {
    const dir = join(cwd, '.claude', 'commands');
    mkdirSync(join(dir, 'qa'), { recursive: true });
    writeFileSync(join(dir, 'deploy.md'), '---\ndescription: ship it\n---\nbody');
    writeFileSync(join(dir, 'qa', 'smoke.md'), 'no frontmatter');
    const cmds = listSlashCommands(cwd);
    const deploy = cmds.find((c) => c.name === 'deploy');
    expect(deploy?.source).toBe('project');
    expect(deploy?.description).toBe('ship it');
    expect(cmds.some((c) => c.name === 'qa:smoke')).toBe(true);
    expect(cmds.some((c) => c.name === 'model' && c.source === 'builtin')).toBe(true);
    // sorted, deduped
    const names = cmds.map((c) => c.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('works with no cwd at all', () => {
    const cmds = listSlashCommands();
    expect(cmds.some((c) => c.name === 'help')).toBe(true);
  });
});
