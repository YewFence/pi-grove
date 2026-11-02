# 0002: Package directory names drop the pi- prefix

Status: Accepted. Supersedes the directory-naming practice introduced with [0001](0001-independent-packages.md).

## Context

Imported packages arrived as `packages/pi-cues`, `packages/pi-bash-jobs`, `packages/pi-edit-diagnostics`, and `packages/pi-ask-user-question`, carrying their standalone-repository names into the monorepo. The repository itself is already named pi-grove, so every path, tag, and workflow reference repeated the pi- prefix the repository name already provides.

## Decision

Name package directories after the extension alone: `packages/cues`, `packages/bash-jobs`, `packages/edit-diagnostics`, `packages/ask-user-question`. The repository name carries the pi- prefix; directories do not.

Release tags follow the directory slug (`cues-v0.3.0`), and the Release workflow triggers on `*-v[0-9]*` tags. npm names are independent of directory names and stay as decided in 0001: `pi-cues` unscoped, the others under `@pi-grove`. Runtime identities that users configure against — the `pi-cues` config paths, cache directory, injection envelope, and `pi-cues-authoring` skill — are product names, not directory names, and keep the prefix.

## Consequences

Directory slugs double as release identifiers everywhere: workflow dispatch inputs, release branches (`release/<slug>`), tags, and commit scopes. Nothing has been published and no release tag exists yet, so this is a rename without migration.
