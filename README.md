# Ateam

English | [中文](README.zh.md)

A desktop workspace for AI coding sessions, with terminal and Stream views,
per-teammate memory, session handoff, and authorized external MCP access.
Built with Tauri, React, TypeScript and a Node sidecar.

**Source available for noncommercial use under PolyForm Noncommercial 1.0.0.**
Commercial use requires a separate license from the copyright holder.
See [LICENSE](LICENSE). Do not describe this license as unrestricted open source.

## Features

- Manage projects and multiple CLI sessions in one desktop workspace.
- Claude, Codex, Cursor CLI and OpenCode provider adapters; capabilities differ
  by provider and installed CLI version.
- Terminal and structured Stream views, tool output, questions and session resume.
- Persistent teammate identities (Humans), skills and knowledge, and handoff.
- External MCP access with project approval, revocation and linked command activity.
- Optional LAN access, hosted remote access and synchronization.

Provider CLIs and accounts are installed/authenticated separately. Their fees,
terms and feature availability are independent of Ateam.

## Build from source

Use Node 22, pnpm 9.15.9 (pinned in package.json), and the Rust stable toolchain
for desktop builds. Native modules must be built on the target OS.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @ateam/desktop-ui build
pnpm --filter @ateam/sidecar build
pnpm --filter @ateam/desktop build
```

The last command creates desktop bundles; it does not install or restart an app.
See [desktop build prerequisites](apps/desktop/BUILD.md).
For a development desktop, build the sidecar first, then run
`pnpm --filter @ateam/desktop dev`.

## Hosted services and future pricing

This source retains the project's existing hosted Relay and update endpoints.
Remote account registration/sign-in connects to that hosted service; desktop
update checks use the configured update endpoint. LAN/Remote/Sync are optional.
See [service and data boundaries](HOSTED_SERVICES.md) before enabling them.

**Hosted server services may become paid in the future.** Pricing, limits and
service conditions will be announced separately. Publishing source does not
promise permanent free hosting or service availability. Source licensing and
hosted-service pricing are separate: access to a paid server service does not,
by itself, grant a commercial license to the software.

The Relay server source is included in `apps/relay`. Self-hosting requires
server configuration and maintenance; it is not a hosted-service entitlement.

## Repository map

- `packages/contract`: RPC types, events and validation.
- `packages/core`: sessions, providers, knowledge integration and external access.
- `packages/knowledge`, `packages/transport`: storage and communication primitives.
- `apps/desktop`: Tauri shell and React UI.
- `apps/sidecar`: desktop Node service and MCP entry points.
- `apps/relay`: remote-access server.
- `apps/cli`, `apps/tui`: command-line surfaces.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Do not attach credentials, private conversations or your Ateam data directory
in public issues. See [third-party notices](THIRD_PARTY_NOTICES.md) before
redistributing builds. This is alpha software; back up local data before upgrades.
