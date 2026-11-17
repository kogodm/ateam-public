import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ateamHome } from './paths';

/**
 * Per-project display aliases — `~/.ateam/project-aliases.json`.
 *
 * DISPLAY ONLY. The alias never reaches spawn args, `tui-state.json`, the
 * per-human project index, or anything that keys off a project: those all
 * keep using the real directory-derived name. Renaming a project here is a
 * label change, not a data migration.
 *
 * The key is the project's GROUP key, which is stable across runs:
 *   • workspace-bound projects → the repo's git-common-dir realpath (or the
 *     directory itself when it isn't a git repo) — the same key that makes a
 *     repo's linked worktrees share one group.
 *   • directory-less "desk" groups → `desk:<humanId>`, because their runtime
 *     projectId is a fresh UUID every launch and would lose the alias.
 */
interface FileShape {
  aliases: Record<string, string>;
}

function aliasPath(): string {
  return join(ateamHome(), 'project-aliases.json');
}

function load(): FileShape {
  try {
    const j = JSON.parse(readFileSync(aliasPath(), 'utf8')) as FileShape;
    return j && typeof j.aliases === 'object' ? { aliases: j.aliases } : { aliases: {} };
  } catch {
    return { aliases: {} }; // missing / malformed → no aliases
  }
}

/** Atomic write (temp + rename) — the desktop and a CLI could both write. */
function save(s: FileShape): void {
  const file = aliasPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file);
}

export function getProjectAlias(key: string): string | undefined {
  if (!key) return undefined;
  return load().aliases[key] || undefined;
}

/** All aliases at once — `list()` resolves every group in one read. */
export function projectAliases(): Record<string, string> {
  return load().aliases;
}

/** Set (or, with an empty string, clear) a project's display alias. Trimmed
 *  and capped; a blank alias removes the entry so the real name shows again. */
export function setProjectAlias(key: string, alias: string): void {
  if (!key) return;
  const s = load();
  const trimmed = alias.trim().slice(0, 60);
  if (trimmed) s.aliases[key] = trimmed;
  else delete s.aliases[key];
  save(s);
}

export function projectAliasPath(): string {
  return aliasPath();
}
