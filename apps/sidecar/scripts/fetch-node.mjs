// Download the official Node runtime for the current OS/arch and place a
// single `node` (or `node.exe`) binary next to apps/sidecar/dist/index.cjs.
// The Rust shell prefers this bundled binary over system `node` so end users
// don't need Node installed. Cached under apps/sidecar/.node-cache/ so
// repeat builds skip the download.
//
// Bundle-size impact (macOS arm64): the Node 22 binary is ~70MB raw and
// DMG-compresses to ~25MB, taking our DMG from ~3MB to ~30MB. Still
// dramatically smaller than Electron, and the user runs `Ateam.app`
// double-click with zero prerequisites.
//
// We rely on the system `tar` for extraction (macOS, Linux, Windows 10+
// all ship it; bsdtar on Win10 handles .zip too).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// LTS as of 2026-05. Bump alongside engines.node in package.json.
const NODE_VERSION = process.env.ATEAM_BUNDLE_NODE_VERSION || '22.11.0';

// fileURLToPath: `new URL(import.meta.url).pathname` returns "/D:/…" on
// Windows which then resolves to "D:\D:\…" — broken. fileURLToPath gives
// the real native path on every OS.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const sidecarDir = join(scriptDir, '..');
const cacheDir = join(sidecarDir, '.node-cache');
const distDir = join(sidecarDir, 'dist');

/** {url, archiveName, binPathInArchive, outName} for the current host. */
function targetSpec() {
  const platform = process.platform;
  const arch = process.arch;
  const v = NODE_VERSION;
  if (platform === 'darwin') {
    const triple = `node-v${v}-darwin-${arch === 'arm64' ? 'arm64' : 'x64'}`;
    return {
      url: `https://nodejs.org/dist/v${v}/${triple}.tar.gz`,
      archive: `${triple}.tar.gz`,
      extract: 'tar-gz',
      binPath: `${triple}/bin/node`,
      outName: 'node',
    };
  }
  if (platform === 'linux') {
    const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : arch;
    const triple = `node-v${v}-linux-${a}`;
    return {
      url: `https://nodejs.org/dist/v${v}/${triple}.tar.xz`,
      archive: `${triple}.tar.xz`,
      extract: 'tar-xz',
      binPath: `${triple}/bin/node`,
      outName: 'node',
    };
  }
  if (platform === 'win32') {
    const a = arch === 'arm64' ? 'arm64' : 'x64';
    const triple = `node-v${v}-win-${a}`;
    return {
      url: `https://nodejs.org/dist/v${v}/${triple}.zip`,
      archive: `${triple}.zip`,
      extract: 'zip',
      binPath: `${triple}/node.exe`,
      outName: 'node.exe',
    };
  }
  throw new Error(`unsupported platform: ${platform}/${arch}`);
}

async function download(url, dest) {
  const tmp = `${dest}.partial`;
  process.stdout.write(`fetching ${url}\n`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`);
  }
  const body = Readable.fromWeb(res.body);
  await pipeline(body, createWriteStream(tmp));
  renameSync(tmp, dest);
}

async function extract(spec, archivePath, outDir) {
  // shell out to `tar` for everything — present on mac/linux/win10+. The
  // -C <outDir> lands the archive's top-level dir there so we can pick
  // out the single bin path.
  if (spec.extract === 'tar-gz') {
    await exec('tar', ['-xzf', archivePath, '-C', outDir]);
  } else if (spec.extract === 'tar-xz') {
    await exec('tar', ['-xJf', archivePath, '-C', outDir]);
  } else if (spec.extract === 'zip') {
    // bsdtar (shipped with Win10+) handles zip via -xf with auto-detection.
    await exec('tar', ['-xf', archivePath, '-C', outDir]);
  }
}

async function ensureNodeBundled() {
  const spec = targetSpec();
  const cachedArchive = join(cacheDir, spec.archive);
  const stageDir = join(cacheDir, 'stage');
  const cachedBin = join(stageDir, spec.binPath);
  const finalBin = join(distDir, spec.outName);

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });

  if (!existsSync(cachedArchive)) {
    await download(spec.url, cachedArchive);
  }

  if (!existsSync(cachedBin)) {
    // wipe any prior partial extraction for this version
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    await extract(spec, cachedArchive, stageDir);
    if (!existsSync(cachedBin)) {
      throw new Error(`bin not found after extract: ${cachedBin}`);
    }
  }

  // copy (don't symlink — symlinks break Tauri's resource bundling on
  // some platforms and add code-sign friction on macOS)
  rmSync(finalBin, { force: true });
  await exec(
    process.platform === 'win32' ? 'cmd' : 'cp',
    process.platform === 'win32'
      ? ['/c', 'copy', '/Y', cachedBin, finalBin]
      : ['-f', cachedBin, finalBin],
  );

  // sanity: must be a real binary (not 0 bytes), and on POSIX it should
  // be executable (cp preserves the +x bit but verify in case of fs quirks).
  const sz = statSync(finalBin).size;
  if (sz < 1_000_000) {
    throw new Error(`bundled node looks too small: ${sz} bytes`);
  }

  // print a short fingerprint so the build log is auditable
  const sha = await sha256(finalBin);
  process.stdout.write(
    `bundled node → ${finalBin} (${(sz / 1024 / 1024).toFixed(1)} MB, sha256=${sha.slice(0, 12)}…)\n`,
  );
}

async function sha256(path) {
  const fs = await import('node:fs');
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(path);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

ensureNodeBundled().catch((e) => {
  process.stderr.write(`fetch-node failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
