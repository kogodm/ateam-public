// node-pty is the only native dep kept external from the bundle. Copy its
// package (incl. build/Release/*.node) next to dist/index.cjs so a packaged
// app can `require('node-pty')` via NODE_PATH=<resource>/node_modules.
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// `new URL(import.meta.url).pathname` returns "/D:/a/…" on Windows; using
// that as a path produces "D:\D:\a\…" once Node prefixes the current drive.
// fileURLToPath gives the real platform-native path on every OS.
const scriptDir = dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const ptyPkg = require.resolve('node-pty/package.json');
const ptyDir = dirname(ptyPkg);

const distNm = join(scriptDir, '..', 'dist', 'node_modules');
const dest = join(distNm, 'node-pty');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(ptyDir, dest, {
  recursive: true,
  dereference: true,
  // strip node_modules anywhere inside the copy (windows uses backslashes)
  filter: (s) => !/(^|[\\/])node_modules([\\/]|$)/.test(s.slice(ptyDir.length)),
});

// node-pty 1.1.0 ships the prebuilt POSIX `spawn-helper` binary in npm
// without the executable bit (mode 0644). On macOS/Linux the runtime
// invokes spawn-helper via posix_spawnp; without +x the syscall fails
// with "posix_spawnp failed." and the GUI silently shows zero sessions.
// Restore +x on every spawn-helper we just copied. Idempotent on platforms
// that already had it (Windows prebuilds use winpty-agent.exe, not this).
for (const arch of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) {
  const helper = join(dest, 'prebuilds', arch, 'spawn-helper');
  if (existsSync(helper)) {
    chmodSync(helper, 0o755);
    process.stdout.write(`chmod +x ${helper}\n`);
  }
}
process.stdout.write(`bundled node-pty → ${dest}\n`);

// Prompts: ship packages/core/prompts/ next to dist/index.cjs so the
// bundled sidecar can read them at runtime (prompts.ts looks up
// __dirname/prompts as the bundled location).
const promptsSrc = join(scriptDir, '..', '..', '..', 'packages', 'core', 'prompts');
const promptsDest = join(scriptDir, '..', 'dist', 'prompts');
rmSync(promptsDest, { recursive: true, force: true });
cpSync(promptsSrc, promptsDest, { recursive: true });
process.stdout.write(`bundled prompts → ${promptsDest}\n`);

// Skill Market: ship packages/core/skills-market/ next to dist/index.cjs so
// the bundled sidecar can read manifest.json + builtin bundles offline.
const marketSrc = join(scriptDir, '..', '..', '..', 'packages', 'core', 'skills-market');
const marketDest = join(scriptDir, '..', 'dist', 'skills-market');
rmSync(marketDest, { recursive: true, force: true });
cpSync(marketSrc, marketDest, { recursive: true });
process.stdout.write(`bundled skills-market → ${marketDest}\n`);

// Human Market: ship packages/core/humans-market/ next to dist/index.cjs so
// the bundled sidecar can read the prefab-teammate roster offline.
const humanMarketSrc = join(scriptDir, '..', '..', '..', 'packages', 'core', 'humans-market');
const humanMarketDest = join(scriptDir, '..', 'dist', 'humans-market');
rmSync(humanMarketDest, { recursive: true, force: true });
cpSync(humanMarketSrc, humanMarketDest, { recursive: true });
process.stdout.write(`bundled humans-market → ${humanMarketDest}\n`);

// Desktop UI: ship apps/desktop/ui/dist as dist/ui so the LAN access server
// can serve the same UI to browsers on the network. The vite build is
// compiled into the Rust binary too, but that copy is unreachable from Node.
// tauri.conf.json builds the UI BEFORE the sidecar so this copy is fresh;
// a missing dist (plain `pnpm --filter @ateam/sidecar build`) just skips —
// the LAN server then serves a "UI not bundled" note, RPC still works.
const uiSrc = join(scriptDir, '..', '..', 'desktop', 'ui', 'dist');
const uiDest = join(scriptDir, '..', 'dist', 'ui');
rmSync(uiDest, { recursive: true, force: true });
if (existsSync(join(uiSrc, 'index.html'))) {
  cpSync(uiSrc, uiDest, { recursive: true });
  process.stdout.write(`bundled desktop UI → ${uiDest}\n`);
} else {
  process.stdout.write(`desktop UI dist not found (${uiSrc}) — LAN server will lack the web UI\n`);
}

// Ship the complete local plugin source alongside the stdio connector.
const pluginRoot = join(scriptDir, '..', 'dist', 'plugin-marketplace');
const repoRoot = join(scriptDir, '..', '..', '..');
rmSync(pluginRoot, { recursive: true, force: true });
cpSync(join(repoRoot, 'plugins', 'ateam'), join(pluginRoot, 'plugins', 'ateam'), { recursive: true });
cpSync(join(repoRoot, '.agents', 'plugins', 'marketplace.json'), join(pluginRoot, '.agents', 'plugins', 'marketplace.json'), { recursive: true });
process.stdout.write(`bundled Ateam plugin marketplace → ${pluginRoot}\n`);
