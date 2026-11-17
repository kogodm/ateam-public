import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketSource } from '@ateam/contract';
import { ateamHome } from './paths';

/**
 * The configured Skill Market sources. `builtin` is the always-present offline
 * catalog; the rest are GitHub marketplace repos (`.claude-plugin/
 * marketplace.json`) fetched on demand. User edits (enable/disable, add,
 * remove) and the 7-day discovery sweep persist to skill-market-sources.json;
 * new app-shipped defaults still surface on upgrade (merged by id) unless the
 * user explicitly removed them.
 */

export const BUILTIN_SOURCE: MarketSource = {
  id: 'builtin',
  name: '内置',
  kind: 'builtin',
  enabled: true,
};

/** App-shipped default marketplaces. Kept in code (not the config file) so an
 *  upgrade can add more without a migration. */
export const DEFAULT_MARKETPLACES: readonly MarketSource[] = [
  {
    id: 'official',
    name: 'Claude 官方插件',
    kind: 'marketplace',
    repo: 'anthropics/claude-plugins-official',
    enabled: true,
  },
  {
    id: 'anthropics-skills',
    name: 'Anthropic Skills',
    kind: 'marketplace',
    repo: 'anthropics/skills',
    enabled: true,
  },
  {
    id: 'daymade',
    name: 'daymade 社区',
    kind: 'marketplace',
    repo: 'daymade/claude-code-skills',
    enabled: true,
  },
];

interface SourcesConfig {
  /** per-id enable/disable overrides (applies to defaults + custom) */
  overrides: Record<string, boolean>;
  /** user-added + auto-discovered marketplaces */
  custom: MarketSource[];
  /** default ids the user removed */
  removed: string[];
  lastDiscoveryAt?: string;
}

function file(): string {
  return join(ateamHome(), 'skill-market-sources.json');
}

function load(): SourcesConfig {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<SourcesConfig>;
    return {
      overrides: raw.overrides ?? {},
      custom: raw.custom ?? [],
      removed: raw.removed ?? [],
      lastDiscoveryAt: raw.lastDiscoveryAt,
    };
  } catch {
    return { overrides: {}, custom: [], removed: [] };
  }
}

function save(cfg: SourcesConfig): void {
  mkdirSync(ateamHome(), { recursive: true });
  writeFileSync(file(), JSON.stringify(cfg, null, 2));
}

/** repo string → a stable source id (owner-repo, lowercased). */
export function repoToId(repo: string): string {
  return repo
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase();
}

/** The full, resolved source list: builtin + surviving defaults + custom,
 *  with enable/disable overrides applied. */
export function listSources(): MarketSource[] {
  const cfg = load();
  const withOverride = (s: MarketSource): MarketSource =>
    s.id in cfg.overrides ? { ...s, enabled: cfg.overrides[s.id] as boolean } : s;
  const defaults = DEFAULT_MARKETPLACES.filter((d) => !cfg.removed.includes(d.id)).map(withOverride);
  const customIds = new Set(cfg.custom.map((c) => c.id));
  const custom = cfg.custom.map(withOverride);
  // custom entries win over a same-id default (shouldn't normally collide)
  const dedupedDefaults = defaults.filter((d) => !customIds.has(d.id));
  return [BUILTIN_SOURCE, ...dedupedDefaults, ...custom];
}

export function getSource(id: string): MarketSource | undefined {
  return listSources().find((s) => s.id === id);
}

export function setSourceEnabled(id: string, enabled: boolean): MarketSource | undefined {
  if (id === 'builtin') return BUILTIN_SOURCE; // always on
  const cfg = load();
  cfg.overrides[id] = enabled;
  save(cfg);
  return getSource(id);
}

/** Add a marketplace source (id derived from repo). Idempotent by id. Caller
 *  is responsible for having validated the repo exposes a marketplace.json. */
export function addSource(input: {
  repo: string;
  name?: string;
  discovered?: boolean;
}): MarketSource {
  const cfg = load();
  const id = repoToId(input.repo);
  // un-remove if it was a removed default
  cfg.removed = cfg.removed.filter((r) => r !== id);
  const existing = listSources().find((s) => s.id === id);
  if (existing) {
    // re-enable a disabled one
    if (!existing.enabled) {
      cfg.overrides[id] = true;
      save(cfg);
    }
    return { ...existing, enabled: true };
  }
  const source: MarketSource = {
    id,
    name: input.name ?? input.repo.replace(/^.*\//, ''),
    kind: 'marketplace',
    repo: input.repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, ''),
    enabled: !input.discovered, // discovered sources start disabled (opt-in)
    ...(input.discovered ? { discovered: true } : {}),
  };
  cfg.custom.push(source);
  save(cfg);
  return source;
}

export function removeSource(id: string): boolean {
  if (id === 'builtin') return false;
  const cfg = load();
  const before = cfg.custom.length;
  cfg.custom = cfg.custom.filter((c) => c.id !== id);
  delete cfg.overrides[id];
  const wasCustom = cfg.custom.length < before;
  const isDefault = DEFAULT_MARKETPLACES.some((d) => d.id === id);
  if (isDefault && !cfg.removed.includes(id)) cfg.removed.push(id);
  save(cfg);
  return wasCustom || isDefault;
}

export function getLastDiscoveryAt(): string | undefined {
  return load().lastDiscoveryAt;
}

export function setLastDiscoveryAt(at: string): void {
  const cfg = load();
  cfg.lastDiscoveryAt = at;
  save(cfg);
}
