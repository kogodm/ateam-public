# @ateam/desktop — Tauri 2 GUI shell

Thin Tauri shell + React/Vite UI over the **same Node core** the TUI embeds.
No backend rewrite: the shell spawns the sidecar (`@ateam/sidecar`, which runs
`createServer` over a loopback WebSocket), captures its `{port,token}`
handshake from stdout, and the webview talks to it through the frozen
`@ateam/contract` envelope.

```
apps/desktop/
  src-tauri/   Rust shell — window + spawn sidecar + get_handshake command
  ui/          @ateam/desktop-ui — React/Vite, browser-native WS RPC client
```

## Prerequisites

- Node 22 + pnpm (already used by the monorepo).
- **Rust ≥ 1.85** for the Tauri 2 dependency graph (current crates.io pulls
  `edition2024` transitive deps). Install or update the stable toolchain:

  ```sh
  rustup update stable
  ```

  The TS/UI side (below) needs no Rust and is fully runnable today.

## Run

Desktop (after the Rust update):

```sh
pnpm --filter @ateam/desktop dev      # tauri dev: vite + spawns the sidecar
```

Browser dev (no Rust, fastest loop) — run the core, then point the UI at it:

```sh
pnpm serve                            # ateam serve → prints ws port; writes handshake
pnpm --filter @ateam/desktop-ui dev   # open the printed Vite URL with
                                      #   ?port=<PORT>&token=<TOKEN>
```

The UI auto-detects Tauri (`get_handshake`) and otherwise reads
`?port=&token=` from the URL, so the exact same frontend runs in both.

## Package (distributable)

```sh
pnpm --filter @ateam/desktop build       # → target/release/bundle/{macos,dmg}
```

`beforeBuildCommand` builds the self-contained sidecar
(`@ateam/sidecar`: tsup bundles core+deps into one `index.cjs`; the only
native dep, `node-pty`, is shipped beside it) and the UI, then Tauri
bundles `Ateam.app` + `Ateam_<v>_<arch>.dmg`. Icons are generated from
`src-tauri/icons/source.png` (regenerate art: `node
src-tauri/icons/gen-icon.mjs` then `cargo tauri icon src-tauri/icons/source.png`).

The packaged app includes a Node runtime, the sidecar and native node-pty.
Users still install and authenticate their chosen provider CLIs separately.

## Status

Feature parity with the TUI: project→session tree, live xterm.js per
session, new-session (existing/new human, recent-dir or directory-less),
titled resume, growth/expertise + evolution feed + workspace
git/filetree + token-ledger panel, localStorage persistence &
restore-on-launch, zoom, unread markers, first-run + re-openable
setup/skill wizard. Packaged `.app`/`.dmg` build verified on macOS
(aarch64). Validate builds on each target OS before distributing them; signing and
notarization require the distributor’s own credentials.
