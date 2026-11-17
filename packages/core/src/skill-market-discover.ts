import type { MarketSource } from '@ateam/contract';
import {
  addSource,
  getLastDiscoveryAt,
  listSources,
  setLastDiscoveryAt,
} from './skill-market-sources';
import { validateMarketplace } from './skill-market-remote';

/**
 * Periodic LLM web-discovery of new Skill Market sources. A headless-claude
 * sweep proposes candidate `owner/repo` marketplaces; each is validated to
 * actually expose a parseable `.claude-plugin/marketplace.json` before it is
 * added — DISABLED by default, so an unknown repo never activates itself. The
 * user opts in from the market's source list.
 */

const DISCOVERY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** The additive method ClaudeSynthesizer exposes (kept off LlmSynthesizer). */
export interface MarketDiscoverer {
  discoverMarketRepos?: (known: string[]) => Promise<string[]>;
}

/** Run the discovery sweep now. Validates candidates and persists the new,
 *  valid ones as disabled sources. Returns what was added. Best-effort. */
export async function discoverSources(synth: MarketDiscoverer): Promise<MarketSource[]> {
  setLastDiscoveryAt(new Date().toISOString()); // stamp up-front so failures still back off
  if (typeof synth.discoverMarketRepos !== 'function') return [];
  const known = listSources()
    .map((s) => s.repo)
    .filter((r): r is string => !!r);
  const knownSet = new Set(known.map((r) => r.toLowerCase()));

  let candidates: string[] = [];
  try {
    candidates = await synth.discoverMarketRepos(known);
  } catch {
    return [];
  }

  const added: MarketSource[] = [];
  for (const repo of candidates) {
    if (knownSet.has(repo.toLowerCase())) continue;
    try {
      const count = await validateMarketplace(repo);
      if (count <= 0) continue;
      added.push(addSource({ repo, discovered: true }));
      knownSet.add(repo.toLowerCase());
    } catch {
      /* not a real/parseable marketplace — skip silently */
    }
  }
  return added;
}

/** Fire the sweep if ≥7 days have passed (or it has never run). Non-blocking
 *  best-effort; callers should not await it on a hot path. */
export async function maybeRunDiscovery(synth: MarketDiscoverer): Promise<MarketSource[]> {
  const last = getLastDiscoveryAt();
  if (last) {
    const age = Date.now() - new Date(last).getTime();
    if (Number.isFinite(age) && age < DISCOVERY_INTERVAL_MS) return [];
  }
  return discoverSources(synth);
}
