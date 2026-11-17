#!/usr/bin/env node
/**
 * node-pty 1.1.0 ships its prebuilt POSIX `spawn-helper` with mode 0644 — no
 * executable bit. The runtime invokes it through posix_spawnp, so EVERY PTY
 * spawned straight out of node_modules dies with "posix_spawnp failed.":
 * `vitest` PTY specs, `pnpm serve`, the tsx sidecar. Packaged apps were fine
 * (apps/sidecar/scripts/bundle-native.mjs chmods the copy it ships), which is
 * why this looked for months like "a broken machine" instead of a repo that
 * cannot spawn a terminal until someone runs chmod.
 *
 * Runs on postinstall so a fresh clone / re-install is usable immediately.
 * Idempotent, and silent when there is nothing to fix.
 */
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

let ptyDir;
try {
  ptyDir = dirname(require.resolve('node-pty/package.json'));
} catch {
  process.exit(0); // node-pty not installed (CI job that skips it) — nothing to do
}

const fixed = [];
for (const arch of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) {
  const helper = join(ptyDir, 'prebuilds', arch, 'spawn-helper');
  if (!existsSync(helper)) continue;
  // already executable by the owner? leave it alone
  if (statSync(helper).mode & 0o100) continue;
  chmodSync(helper, 0o755);
  fixed.push(`${arch}/spawn-helper`);
}
// also the locally-compiled build, when node-pty was built from source
const built = join(ptyDir, 'build', 'Release', 'spawn-helper');
if (existsSync(built) && !(statSync(built).mode & 0o100)) {
  chmodSync(built, 0o755);
  fixed.push('build/Release/spawn-helper');
}

if (fixed.length) process.stdout.write(`chmod +x node-pty: ${fixed.join(', ')}\n`);
