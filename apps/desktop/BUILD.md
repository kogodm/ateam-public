# Desktop builds

The Tauri shell targets all three desktop OSes. Native modules (`node-pty`)
must be installed and built **on the target OS** — cross-compile won't work.

## macOS

```bash
pnpm install
pnpm --filter @ateam/desktop tauri build
# artifacts:
#   apps/desktop/src-tauri/target/release/bundle/macos/Ateam.app
#   apps/desktop/src-tauri/target/release/bundle/dmg/Ateam_<ver>_<arch>.dmg
```

`aarch64` = Apple Silicon. For Intel Macs build on an Intel host (or via Rosetta).

## Windows

Prerequisites on the build machine:

- Node ≥ 22 (`node --version`)
- pnpm ≥ 9
- Rust toolchain (`rustup default stable` ≥ 1.80)
- WebView2 runtime (Win10+: install separately; Win11: preinstalled)
- Visual Studio Build Tools 2022 (Desktop dev with C++) — for `node-pty` native build

```powershell
pnpm install               # builds node-pty with Windows winpty/conpty
pnpm --filter @ateam/desktop tauri build
# artifacts:
#   apps\desktop\src-tauri\target\release\bundle\nsis\Ateam_<ver>_x64-setup.exe
#   apps\desktop\src-tauri\target\release\bundle\msi\Ateam_<ver>_x64_en-US.msi
```

Runtime requirements on the user's machine:

- **Node**: NOT required. The Tauri shell ships with an official Node 22 LTS
  binary next to `index.cjs` (fetched per-platform at build time by
  `apps/sidecar/scripts/fetch-node.mjs`). System `node` is used only as a
  fallback for older builds that pre-date the bundled-node change.
- **claude** CLI on PATH, or `%LOCALAPPDATA%\Programs\claude\claude.exe`,
  or `$Env:ATEAM_CLAUDE_BIN` set to the full path.

Notes:

- `tauri.conf.json` uses `targets: "all"` — Tauri auto-skips bundle types that
  don't apply to the current OS, so the same config builds DMG on macOS and
  NSIS/MSI on Windows without conditional branching.
- The sidecar spawn from the Rust shell uses `CREATE_NO_WINDOW` on Windows so
  no black console window flashes when launching `node`.

## Linux

```bash
pnpm install
pnpm --filter @ateam/desktop tauri build
# artifacts:
#   apps/desktop/src-tauri/target/release/bundle/appimage/...
#   apps/desktop/src-tauri/target/release/bundle/deb/...
```

Runtime: needs `claude` (or `$ATEAM_CLAUDE_BIN`) and `xdg-open` for the
"open path with default app" flow when no specific app is selected. Node is
shipped bundled — no system Node required.

## Provider runtimes

Adapters are registered for Claude, Codex, Cursor CLI and OpenCode under
`packages/core/src/session/providers/`. Install and authenticate the selected
CLI separately. Supported resume, MCP and recall behavior varies by provider
and CLI version; refer to those adapters and their tests.

## macOS / Linux prerequisites

Use Node 22, pnpm 9.15.9 and Rust stable (at least 1.85). macOS requires Xcode
Command Line Tools. Linux also requires the WebKit/GTK/native compiler packages
for Tauri 2 (distribution names vary; for Ubuntu this includes
`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`,
`librsvg2-dev`, `libssl-dev`, `libxdo-dev`, `patchelf` and `build-essential`).

Run `pnpm install --frozen-lockfile` before building. Source builds retain the
upstream hosted Relay and update endpoints; read [HOSTED_SERVICES.md](../../HOSTED_SERVICES.md)
before distributing a build. No signing credentials or server access are supplied.
