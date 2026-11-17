import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HumanMarketItem } from '@ateam/contract';

/**
 * Human Market — a curated catalog of prefab teammates, grouped by industry
 * and role. Each item carries a set of built-in skill ids (SkillMarketItem
 * ids); hiring one creates a Human and installs those skills.
 *
 * Layout in the repo (bundled into apps/sidecar/dist/humans-market, mirroring
 * the skills-market dist-copy in scripts/bundle-native.mjs):
 *   humans-market/
 *   └─ manifest.json      ← list of prefab humans
 *
 * The prefabs reference skill bundles that already ship in skills-market, so
 * this module owns no skill files of its own — only the roster.
 */

let cachedDir: string | undefined;
function marketDir(): string {
  if (cachedDir) return cachedDir;
  const here = typeof __dirname !== 'undefined' ? __dirname : dirname(process.argv[1] ?? '.');
  // mirrors skill-market.ts resolution: bundled dist sits next to index.cjs,
  // dev tsx points at packages/core/humans-market via the src parent.
  const candidates = [join(here, 'humans-market'), join(here, '..', 'humans-market')];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedDir = c;
      return c;
    }
  }
  cachedDir = candidates[0] ?? '';
  return cachedDir;
}

interface RawManifest {
  items: HumanMarketItem[];
}

export function listHumanMarketItems(): HumanMarketItem[] {
  const f = join(marketDir(), 'manifest.json');
  if (!existsSync(f)) return [];
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as RawManifest;
    return raw.items ?? [];
  } catch {
    return [];
  }
}

export function getHumanMarketItem(id: string): HumanMarketItem | undefined {
  return listHumanMarketItems().find((x) => x.id === id);
}
