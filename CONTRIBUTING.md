# Contributing

This project uses the PolyForm Noncommercial 1.0.0 license in LICENSE. Read it
before using, modifying or distributing the project. Submit only material you
have the right to contribute; identify third-party code and its original license.

## Development

Use Node 22 and pnpm 9.15.9. Install with `pnpm install --frozen-lockfile`.
Keep changes focused, add regression coverage for behavioral fixes, and run:

```sh
pnpm typecheck
pnpm exec vitest run <affected-test-files>
pnpm --filter @ateam/desktop-ui build   # when changing UI
git diff --check
```

Native PTY tests need a supported host and native dependencies. Use temporary
ATEAM_HOME directories and fake CLIs when testing session behavior. Never use
real user credentials, projects or conversations as test fixtures. Do not run a
whole-repository formatter as part of an unrelated change.

## Pull requests

Describe the behavior before/after, validation results and remaining limitations.
Do not attach tokens, personal paths, session exports or unredacted logs.
The maintainer develops in a private repository and exports reviewed source
snapshots here. Public changes are imported into that development line before
the next export; public Git history is independent of private history.

A source contribution does not authorize deployment, publication of binaries,
or use of the maintainer's hosted infrastructure.
