# 0001: Independent extension packages in pi-grove

Status: Accepted.

## Context

Five extensions had separate toolchains and uneven publication support. They need one development environment while retaining separate installation and release schedules. pi-cues already has npm users and a git-cliff release workflow.

## Decision

Use one aube workspace with shared SDK and development tools, private root and docs packages, and independently versioned extension packages. Keep `pi-cues` unscoped; publish new packages under `@pi-grove`. Ship TypeScript sources with explicit pi resources. Keep runtime dependencies package-local and avoid a shared runtime until multiple extensions need one.

Retain git-cliff for path-filtered versioning and original commit identities. Use the trusted prebuilt Josh binary for package history fingerprints. Keep portable release operations behind mise tasks and GitHub API orchestration in workflow adapter scripts. Maintain one release PR, immutable tag, and serialized publishing queue per package. A migration baseline prevents imported history from triggering new versions.

pi-cues retains its global configuration under `<agent-dir>/extensions/pi-cues/`, with the agent directory following `PI_CODING_AGENT_DIR` and defaulting to `~/.pi/agent`; its project configuration and pi's host trust directory keep their respective purposes. The questionnaire owns a small JSON configuration loader and English UI. Remove upstream configuration and i18n packages instead of carrying their ecosystem-specific integration.

## Rejected alternatives

A single package or shared version ties unrelated features and release times together. Release Please and Changesets would replace an existing working release mechanism with another dependency and were explicitly declined. Using a Josh projection for all changelog generation requires mapping filtered commit SHAs and tags back to the original repository; native git-cliff path filters retain original identities. Publishing compiled entry points adds a build step without serving a current non-pi consumer.

## Consequences

New packages register themselves through workspace manifests. Each package is tested and packed independently. Release preparation adds small platform scripts, and package freshness depends on the chosen Josh filter. Changes to runtime dependency resolutions must be considered explicitly. Historical pi-cues ADRs 0009 and 0014 remain unchanged, and ADR 0014 continues to define the pi-cues global configuration path.
