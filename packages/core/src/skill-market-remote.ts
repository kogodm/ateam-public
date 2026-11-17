import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { MarketSource, SkillMarketItem } from '@ateam/contract';
import { ateamHome } from './paths';

/**
 * Remote Skill Market sources — GitHub repos exposing a `.claude-plugin/
 * marketplace.json`. Nothing is pre-bundled: the catalog is fetched when the
 * user opens the market, and a plugin's skill files are git-cloned only when
 * the user installs that specific item.
 *
 * marketplace.json shape (observed across anthropics/*, community repos):
 *   { name, owner, plugins: [ { name, description, category?, author?, tags?,
 *       source } ] }
 * where `source` is EITHER
 *   - a string: a repo-relative path ("./", "./plugins/foo") → the plugin lives
 *     in the marketplace repo itself at that path; OR
 *   - an object: { source:"git-subdir", url, path, ref?, sha? } → the plugin
 *     lives in another repo at `path`.
 */

const exec = promisify(execFile);

// --- pure parsing (unit-tested) ---

interface RawPlugin {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  keywords?: string[];
  author?: string | { name?: string };
  source?: string | { source?: string; url?: string; path?: string; ref?: string; sha?: string };
}
interface RawMarketplace {
  plugins?: RawPlugin[];
}

function authorName(a: RawPlugin['author']): string | undefined {
  if (!a) return undefined;
  return typeof a === 'string' ? a : a.name;
}

/**
 * Turn a fetched marketplace.json into SkillMarketItems. Pure — no I/O — so the
 * shape handling (string vs object source) is tested against real fixtures.
 */
export function parseMarketplace(raw: unknown, source: MarketSource): SkillMarketItem[] {
  const doc = raw as RawMarketplace;
  const plugins = Array.isArray(doc?.plugins) ? doc.plugins : [];
  const repo = (source.repo ?? '').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  const items: SkillMarketItem[] = [];
  for (const p of plugins) {
    if (!p?.name) continue;
    let repoUrl: string;
    let path: string;
    let ref: string | undefined;
    let sha: string | undefined;
    if (typeof p.source === 'object' && p.source?.url) {
      repoUrl = p.source.url;
      path = (p.source.path ?? '').replace(/^\.?\//, '');
      ref = p.source.ref;
      sha = p.source.sha;
    } else if (typeof p.source === 'string') {
      if (!repo) continue; // can't resolve a relative path without the host repo
      repoUrl = `https://github.com/${repo}.git`;
      path = p.source.replace(/^\.?\//, '');
    } else {
      continue;
    }
    const tags = p.tags ?? p.keywords ?? [];
    items.push({
      id: `${source.id}:${p.name}`,
      name: p.name,
      description: (p.description ?? '').slice(0, 400),
      category: p.category ?? source.name,
      tags: [...tags, ...(p.category ? [p.category] : [])],
      source: repoUrl,
      kind: 'tree',
      entry: 'SKILL.md',
      builtin: false,
      sourceId: source.id,
      author: authorName(p.author),
      remote: { repoUrl, path, ...(ref ? { ref } : {}), ...(sha ? { sha } : {}) },
    });
  }
  return items;
}

// --- network fetch (cached) ---

interface CacheEntry {
  at: number;
  items: SkillMarketItem[];
}
const CATALOG_TTL_MS = 10 * 60 * 1000;
const catalogCache = new Map<string, CacheEntry>();

/** now() indirection kept tiny so tests can seed the cache deterministically. */
function fresh(e: CacheEntry | undefined): boolean {
  return !!e && Date.now() - e.at < CATALOG_TTL_MS;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'user-agent': 'ateam' } });
  if (!res.ok) throw new Error(`market: ${res.status} for ${url}`);
  return res.json();
}

/** Fetch + parse a marketplace source's catalog (dynamic, TTL-cached). Tries
 *  raw.githubusercontent first, then the GitHub contents API as a fallback. */
export async function fetchMarketplace(source: MarketSource): Promise<SkillMarketItem[]> {
  if (source.kind !== 'marketplace' || !source.repo) return [];
  const cached = catalogCache.get(source.id);
  if (fresh(cached)) return (cached as CacheEntry).items;
  const repo = source.repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  const rawUrl = `https://raw.githubusercontent.com/${repo}/HEAD/.claude-plugin/marketplace.json`;
  let doc: unknown;
  try {
    doc = await fetchJson(rawUrl);
  } catch {
    // fallback: contents API returns { content: base64 }
    const api = `https://api.github.com/repos/${repo}/contents/.claude-plugin/marketplace.json`;
    const j = (await fetchJson(api)) as { content?: string };
    if (!j.content) throw new Error(`market: no marketplace.json for ${repo}`);
    doc = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  }
  const items = parseMarketplace(doc, source);
  catalogCache.set(source.id, { at: Date.now(), items });
  return items;
}

/** Validate that a repo exposes a parseable marketplace.json (used before a
 *  source is persisted). Returns the item count, or throws. */
export async function validateMarketplace(repo: string): Promise<number> {
  const items = await fetchMarketplace({
    id: 'probe',
    name: repo,
    kind: 'marketplace',
    repo,
    enabled: true,
  });
  catalogCache.delete('probe');
  return items.length;
}

// --- install-time resolution (git clone the plugin subdir on demand) ---

/** Clone the item's repo (shallow) and return the local dir to import — the
 *  plugin's `skills/` folder when present, else the plugin dir itself. Cached
 *  under ~/.ateam/cache/market so a re-install is offline. */
export async function resolveRemoteSkill(item: SkillMarketItem): Promise<string> {
  if (!item.remote) throw new Error(`market: ${item.id} has no remote source`);
  const { repoUrl, path, ref, sha } = item.remote;
  const key = (sha ?? ref ?? 'head').slice(0, 12).replace(/[^a-zA-Z0-9]/g, '');
  const safeName = item.name.replace(/[^a-zA-Z0-9._-]/g, '-');
  const cacheRoot = join(ateamHome(), 'cache', 'market', item.sourceId ?? 'remote');
  const dest = join(cacheRoot, `${safeName}-${key}`);
  const skillDir = (dir: string): string => {
    const withPath = path ? join(dir, path) : dir;
    const skills = join(withPath, 'skills');
    return existsSync(skills) ? skills : withPath;
  };
  if (existsSync(dest)) return skillDir(dest);

  mkdirSync(cacheRoot, { recursive: true });
  const tmp = join(tmpdir(), `ateam-mkt-${safeName}-${Date.now()}`);
  const args = ['clone', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push(repoUrl, tmp);
  try {
    await exec('git', args, { timeout: 120_000 });
    const src = path ? join(tmp, path) : tmp;
    if (!existsSync(src)) throw new Error(`market: subdir ${path} missing in ${repoUrl}`);
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
    return skillDir(dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Dirs under `root` that hold a SKILL.md — the individually-importable units.
 *  A plugin may bundle several skills (skills/<name>/SKILL.md), or be a single
 *  skill (SKILL.md at root). Searches depth ≤2. */
export function findSkillUnits(root: string): string[] {
  const found: string[] = [];
  const hasSkill = (dir: string): boolean => existsSync(join(dir, 'SKILL.md'));
  const walk = (dir: string, depth: number): void => {
    if (hasSkill(dir)) {
      found.push(dir);
      return; // a unit dir is a leaf — don't descend into its own references
    }
    if (depth <= 0) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch {
      return;
    }
    for (const name of entries) walk(join(dir, name), depth - 1);
  };
  walk(root, 2);
  return found;
}
