# Hosted services and data boundaries

## Source license and hosting

Ateam source is provided under PolyForm Noncommercial 1.0.0. Commercial use
requires separate permission. Hosted server services may become paid; pricing,
quotas and service conditions will be announced separately. Neither free hosting
nor continued availability is promised by publication of this repository.
Buying hosted service access does not by itself grant commercial software rights.

## Connections retained in this source

- The default account/Relay service is configured by `DEFAULT_RELAY_BASE_URL`
  in `packages/core/src/config.ts`. Remote registration and sign-in use it.
- The desktop update endpoint and verification public key are in
  `apps/desktop/src-tauri/tauri.conf.json`. The public key is not a signing secret.
  Source builds retain the upstream update feed: applying an offered update can
  replace a locally built app with the upstream distribution.
- Provider CLIs communicate with their respective providers. Skill marketplace
  discovery/install and build tooling can download third-party resources.

LAN, Remote and Sync start disabled in the default configuration. Do not infer
that every network request is controlled by those toggles: updates, provider
CLIs and marketplace operations have their own behavior.

## Access and sensitive data

The application runs local CLI processes and can access files and execute commands
with the user's OS permissions. External MCP uses a separate approval flow for
projects and capabilities. Registering a connector is not project approval.
Remote access, synchronization and provider tools have different data paths;
review their implementation before exposing private projects or infrastructure.
This document is a technical disclosure, not a promise that no data ever leaves
the machine, an SLA, or a complete hosted-service privacy policy.

## Self-hosting

Relay source is in `apps/relay`. A fork operator must configure their own service,
certificates, access controls and update infrastructure before distributing a
fork that redirects users elsewhere. Preserve the software license and applicable
third-party notices. Hosted-service terms/privacy disclosures need to be finalized
before a public service launch or charging users.
