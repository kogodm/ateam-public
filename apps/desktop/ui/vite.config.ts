import { readFileSync, writeFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Version comes from the Tauri bundle config (single source of truth).
const version = (
  JSON.parse(readFileSync('../src-tauri/tauri.conf.json', 'utf8')) as { version: string }
).version;

// Build number: a running counter that increments on every real build and
// resets to 1 whenever the version changes — so Settings shows e.g.
// "v0.4.3 · build 4" and you can confirm you opened the freshly-built app.
// Persisted in a gitignored file next to this config.
const COUNTER = './.build-counter.json';
function buildNumber(isBuild: boolean): number {
  let prev: { version?: string; n?: number } = {};
  try {
    prev = JSON.parse(readFileSync(COUNTER, 'utf8')) as { version?: string; n?: number };
  } catch {
    /* first build */
  }
  const same = prev.version === version;
  if (!isBuild) return same && prev.n ? prev.n : 0; // dev server: don't bump
  const n = same && prev.n ? prev.n + 1 : 1;
  try {
    writeFileSync(COUNTER, JSON.stringify({ version, n }));
  } catch {
    /* ignore */
  }
  return n;
}

// Tauri drives this dev server; the port must match tauri.conf.json devUrl.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_ID__: JSON.stringify(String(buildNumber(command === 'build'))),
  },
}));
