import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { SkillMarketItem } from '@ateam/contract';
import { ateamHome } from './paths';

/**
 * Skill Market — curated catalog of pre-bundled skills. v1 ships a builtin
 * manifest co-located with the prompts (same dist-copy pattern), plus the
 * ability to install items whose `source` is an `https:` tar.gz URL.
 *
 * Layout in the repo (and bundled into apps/sidecar/dist/skills-market):
 *   skills-market/
 *   ├─ manifest.json              ← list of items
 *   └─ builtin/<id>/SKILL.md      ← the bundle for builtin items
 *
 * Install resolves the source:
 *  - `file://<rel>`   → repo-relative dir; pass directly to importSkillUnit.
 *  - `https://…`      → fetch tar.gz → verify sha256 (if given) → extract to
 *                       `~/.ateam/cache/market/<id>-<sha8>/` → importSkillUnit.
 */

const exec = promisify(execFile);

let cachedDir: string | undefined;
function marketDir(): string {
  if (cachedDir) return cachedDir;
  const here = typeof __dirname !== 'undefined' ? __dirname : dirname(process.argv[1] ?? '.');
  // mirrors prompts.ts resolution: bundled dist sits next to index.cjs, dev
  // tsx points at packages/core/skills-market via the src parent.
  const candidates = [
    join(here, 'skills-market'),
    join(here, '..', 'skills-market'),
  ];
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
  items: SkillMarketItem[];
}

export function listMarketItems(): SkillMarketItem[] {
  const f = join(marketDir(), 'manifest.json');
  if (!existsSync(f)) return [];
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as RawManifest;
    return raw.items ?? [];
  } catch {
    return [];
  }
}

export function getMarketItem(id: string): SkillMarketItem | undefined {
  return listMarketItems().find((x) => x.id === id);
}

/** Resolve a market item's `source` to a local directory ready for
 *  importSkillUnit. For HTTPS items the tar.gz is fetched and extracted to
 *  the cache on the first install; subsequent installs reuse the cache. */
export async function resolveMarketSource(item: SkillMarketItem): Promise<string> {
  if (item.source.startsWith('file://')) {
    const rel = item.source.slice('file://'.length);
    const abs = join(marketDir(), rel);
    if (!existsSync(abs)) throw new Error(`market: builtin path missing: ${abs}`);
    return abs;
  }
  if (item.source.startsWith('https://')) {
    const cache = join(ateamHome(), 'cache', 'market');
    mkdirSync(cache, { recursive: true });
    const sha8 = item.sha256?.slice(0, 8) ?? 'na';
    const dest = join(cache, `${item.id}-${sha8}`);
    if (!existsSync(dest)) {
      const tmp = `${dest}.tar.gz.partial`;
      // download
      const res = await fetch(item.source);
      if (!res.ok || !res.body) {
        throw new Error(`market: download failed ${res.status} for ${item.source}`);
      }
      // node 22's fetch returns a Web ReadableStream; pipe to file via Readable.
      const body = Readable.fromWeb(res.body as never);
      await pipeline(body, createWriteStream(tmp));
      // integrity check if a sha256 was declared
      if (item.sha256) {
        const buf = readFileSync(tmp);
        const got = createHash('sha256').update(buf).digest('hex');
        if (got !== item.sha256) {
          rmSync(tmp, { force: true });
          throw new Error(
            `market: sha256 mismatch for ${item.id}: expected ${item.sha256}, got ${got}`,
          );
        }
      }
      mkdirSync(dest, { recursive: true });
      // extract via system tar (macOS + Linux ship it; bsdtar on macOS handles
      // both gzip and zstd if we add it later). `--strip-components=1` so a
      // wrapping top-level dir flattens to `dest`.
      try {
        await exec('tar', ['-xzf', tmp, '-C', dest, '--strip-components=1']);
      } catch (e) {
        // fall back without strip if the archive isn't wrapped
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(dest, { recursive: true });
        await exec('tar', ['-xzf', tmp, '-C', dest]);
        void e;
      }
      rmSync(tmp, { force: true });
    }
    return dest;
  }
  throw new Error(`market: unsupported source scheme: ${item.source}`);
}

/** Sanity-check the extracted/builtin dir has the entry file the manifest
 *  promised. Caller passes this to importSkillUnit. */
export function entryPathFor(dir: string, item: SkillMarketItem): string {
  const target = join(dir, item.entry);
  if (!existsSync(target)) {
    // some archives ship lowercase / different filenames — try a one-level
    // case-insensitive lookup before giving up
    try {
      const matches = readdirSync(dir).filter(
        (f) => f.toLowerCase() === item.entry.toLowerCase(),
      );
      if (matches[0]) return join(dir, matches[0]);
    } catch {
      /* ignore */
    }
    throw new Error(`market: entry ${item.entry} not found in ${dir}`);
  }
  if (!statSync(target).isFile()) {
    throw new Error(`market: entry ${item.entry} is not a file`);
  }
  return target;
}
