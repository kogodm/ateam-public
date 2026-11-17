import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { type Assignment, assignmentsFor } from './skill-assignments';

export type SkillOrigin = 'project' | 'global-claude' | 'global-cursor' | 'global-codex';

export interface DiscoveredSource {
  id: string;
  label: string;
  origin: SkillOrigin;
  path: string;
  kind: 'file' | 'dir';
  count: number;
}

const DOC_EXT = new Set(['.md', '.mdc', '.markdown', '.mdx']);
const NAMED = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  'AGENT.md',
  '.windsurfrules',
  '.clinerules',
  '.cursorrules',
  '.rules',
  'copilot-instructions.md',
]);
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv']);

export function isDoc(name: string): boolean {
  return DOC_EXT.has(extname(name).toLowerCase()) || NAMED.has(name);
}

export function countDocs(path: string, depth = 6): number {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return 0;
  }
  if (st.isFile()) return isDoc(path.split('/').pop() ?? '') ? 1 : 0;
  if (!st.isDirectory() || depth < 0) return 0;
  let n = 0;
  try {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      if (e.name.startsWith('.git') || SKIP.has(e.name)) continue;
      const p = join(path, e.name);
      if (e.isDirectory()) n += countDocs(p, depth - 1);
      else if (isDoc(e.name)) n++;
      if (n > 800) break;
    }
  } catch {
    /* unreadable */
  }
  return n;
}

function add(
  list: DiscoveredSource[],
  origin: SkillOrigin,
  label: string,
  path: string,
): void {
  if (!existsSync(path)) return;
  let kind: 'file' | 'dir';
  try {
    kind = statSync(path).isDirectory() ? 'dir' : 'file';
  } catch {
    return;
  }
  const count = countDocs(path);
  if (count === 0) return;
  list.push({ id: `${origin}:${label}`, label, origin, path, kind, count });
}

/** Skills shipped by INSTALLED Claude Code plugins. Marketplace installs
 *  live under ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ —
 *  we only trust installed_plugins.json (the raw cache also holds stale
 *  versions and other tools' variants). Each install contributes its
 *  skills/ + commands/ + agents/ dirs when they contain docs. */
function addPluginSources(out: DiscoveredSource[], home: string): void {
  const manifest = join(home, '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(manifest)) return;
  let plugins: Record<string, { installPath?: string }[]> = {};
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      plugins?: Record<string, { installPath?: string }[]>;
    };
    plugins = parsed.plugins ?? {};
  } catch {
    return;
  }
  for (const [key, installs] of Object.entries(plugins)) {
    const ip = installs?.[0]?.installPath;
    if (!ip) continue;
    for (const sub of ['skills', 'commands', 'agents']) {
      // key is "name@marketplace" — keep it whole so two marketplaces
      // shipping the same plugin name stay distinct.
      add(out, 'global-claude', `plugin:${key}/${sub}/`, join(ip, sub));
    }
  }
}

/**
 * Auto-discover existing skills/rules/instructions instead of making the user
 * type a path: the working dir + global Claude / Cursor / Codex locations.
 */
export function discoverSkillSources(cwd: string): DiscoveredSource[] {
  const home = homedir();
  const out: DiscoveredSource[] = [];

  // global Claude (~/.claude)
  const c = join(home, '.claude');
  add(out, 'global-claude', 'CLAUDE.md', join(c, 'CLAUDE.md'));
  add(out, 'global-claude', 'rules/', join(c, 'rules'));
  add(out, 'global-claude', 'skills/', join(c, 'skills'));
  add(out, 'global-claude', 'agents/', join(c, 'agents'));
  add(out, 'global-claude', 'commands/', join(c, 'commands'));
  add(out, 'global-claude', 'output-styles/', join(c, 'output-styles'));
  addPluginSources(out, home);

  // global Cursor (~/.cursor). skills/ is the user's own skill dir (Cursor
  // 2.x); skills-cursor/ is deliberately excluded — Cursor's built-in
  // self-referential skills (create-rule, automate…) are noise for claude.
  add(out, 'global-cursor', 'rules/', join(home, '.cursor', 'rules'));
  add(out, 'global-cursor', 'skills/', join(home, '.cursor', 'skills'));

  // global Codex (~/.codex)
  const cx = join(home, '.codex');
  add(out, 'global-codex', 'AGENTS.md', join(cx, 'AGENTS.md'));
  add(out, 'global-codex', 'instructions.md', join(cx, 'instructions.md'));
  add(out, 'global-codex', 'prompts/', join(cx, 'prompts'));

  // working directory / project
  add(out, 'project', 'CLAUDE.md', join(cwd, 'CLAUDE.md'));
  add(out, 'project', 'AGENTS.md', join(cwd, 'AGENTS.md'));
  add(out, 'project', '.claude/', join(cwd, '.claude'));
  add(out, 'project', '.cursor/rules/', join(cwd, '.cursor', 'rules'));
  add(out, 'project', '.cursor/skills/', join(cwd, '.cursor', 'skills'));
  add(out, 'project', '.cursorrules', join(cwd, '.cursorrules'));
  add(out, 'project', '.windsurfrules', join(cwd, '.windsurfrules'));
  add(out, 'project', '.clinerules', join(cwd, '.clinerules'));
  add(out, 'project', '.rules', join(cwd, '.rules'));
  add(out, 'project', '.github/copilot-instructions.md', join(cwd, '.github', 'copilot-instructions.md'));

  return out;
}

// --- skill units: the granular, individually-assignable thing ---

export type SkillUnitKind = 'file' | 'bundle' | 'tree';
export interface SkillUnit {
  /** canonical absolute path (the assignment key) */
  path: string;
  label: string;
  origin: SkillOrigin;
  kind: SkillUnitKind;
  /** entry doc within the unit (relative to path for dir units) */
  entry: string;
  docCount: number;
  assignedTo: Assignment[];
}

function hasFile(dir: string, name: string): boolean {
  return existsSync(join(dir, name));
}
function skillMdIn(dir: string): string | undefined {
  try {
    for (const e of readdirSync(dir)) if (e.toUpperCase() === 'SKILL.MD') return join(dir, e);
  } catch {
    /* unreadable */
  }
  return undefined;
}
/** Direct child dirs that ARE a skill bundle (contain SKILL.md). */
function bundleChildren(root: string): string[] {
  const out: string[] = [];
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      if (skillMdIn(join(root, e.name))) out.push(join(root, e.name));
    }
  } catch {
    /* unreadable */
  }
  return out;
}
function pickEntry(dir: string): string {
  for (const n of ['README.md', 'readme.md', 'index.md', 'CLAUDE.md', 'AGENTS.md', 'INDEX.md']) {
    if (hasFile(dir, n)) return n;
  }
  try {
    const f = readdirSync(dir).find((x) => isDoc(x));
    if (f) return f;
  } catch {
    /* unreadable */
  }
  return '';
}

/**
 * Discover individually-selectable skill *units*, preserving structure:
 *  - a dir with SKILL.md (or a collection of such dirs)  -> one bundle per skill
 *  - a cross-referencing rules/docs tree                 -> ONE tree unit (whole dir,
 *    so `../common` style refs keep resolving)
 *  - a standalone doc file                               -> a file unit
 * Each is annotated with which humans already have it.
 */
export function discoverSkillUnits(cwd: string): SkillUnit[] {
  const units: SkillUnit[] = [];
  const seen = new Set<string>();
  const push = (u: Omit<SkillUnit, 'assignedTo'>): void => {
    if (seen.has(u.path)) return;
    seen.add(u.path);
    units.push({ ...u, assignedTo: assignmentsFor(u.path) });
  };

  for (const src of discoverSkillSources(cwd)) {
    if (src.kind === 'file') {
      push({
        path: src.path,
        label: src.label,
        origin: src.origin,
        kind: 'file',
        entry: basename(src.path),
        docCount: 1,
      });
      continue;
    }
    const bundles = bundleChildren(src.path);
    if (bundles.length > 0) {
      for (const b of bundles) {
        push({
          path: b,
          label: `${src.label}${basename(b)}/`,
          origin: src.origin,
          kind: 'bundle',
          entry: 'SKILL.md',
          docCount: countDocs(b),
        });
      }
      // Non-bundle siblings used to be DROPPED entirely — a `learned/`
      // collection or loose .md next to SKILL.md bundles never showed up
      // in setup. Surface them too: loose docs as file units; non-bundle
      // dirs as nested bundles (one level deeper) or a tree unit.
      const bundleSet = new Set(bundles);
      try {
        for (const e of readdirSync(src.path, { withFileTypes: true })) {
          if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
          const p = join(src.path, e.name);
          if (bundleSet.has(p)) continue;
          if (e.isFile()) {
            if (isDoc(e.name)) {
              push({
                path: p,
                label: `${src.label}${e.name}`,
                origin: src.origin,
                kind: 'file',
                entry: e.name,
                docCount: 1,
              });
            }
            continue;
          }
          if (!e.isDirectory()) continue;
          const nested = bundleChildren(p);
          if (nested.length > 0) {
            for (const b of nested) {
              push({
                path: b,
                label: `${src.label}${e.name}/${basename(b)}/`,
                origin: src.origin,
                kind: 'bundle',
                entry: 'SKILL.md',
                docCount: countDocs(b),
              });
            }
          } else {
            const n = countDocs(p);
            if (n > 0) {
              push({
                path: p,
                label: `${src.label}${e.name}/`,
                origin: src.origin,
                kind: 'tree',
                entry: pickEntry(p),
                docCount: n,
              });
            }
          }
        }
      } catch {
        /* unreadable */
      }
    } else {
      push({
        path: src.path,
        label: src.label,
        origin: src.origin,
        kind: 'tree',
        entry: pickEntry(src.path),
        docCount: src.count,
      });
    }
  }
  return units;
}
