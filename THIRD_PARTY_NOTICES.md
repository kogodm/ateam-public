# Third-party software and assets

The root LICENSE applies to Ateam's own code. Third-party dependencies retain
their own licenses; the noncommercial restriction does not replace those terms.

Dependency inventories are in `pnpm-lock.yaml`, workspace `package.json` files
and `apps/desktop/src-tauri/Cargo.toml`. Desktop distribution bundles a Node
runtime, native node-pty components and bundled JavaScript dependencies. Keep
all notices required by their upstream licenses when redistributing binaries.

Before publishing binary releases, generate and review a dependency license
inventory and include the required notices for the exact shipped versions.
A lockfile is not a complete attribution bundle. This preparation has not yet
completed a binary-distribution license audit.

Icons, avatars and built-in skill/marketplace content need a provenance review
before the first public snapshot. Inclusion in this repository alone does not
establish ownership or permission. Provider/product names identify integrations;
publication does not imply endorsement by those providers.

[THIRD_PARTY_DEPENDENCIES.json](THIRD_PARTY_DEPENDENCIES.json) records the name,
version and declared license of 246 installed JavaScript dependency entries.
It includes development dependencies and is not a substitute for license texts.
The CC-BY-4.0 entry is `caniuse-lite`; preserve its upstream attribution when
redistributing applicable material. Rust and the bundled Node runtime need
separate review.
