Use aube for all Node dependencies and keep one root workspace lockfile. Run `mise run check` before finishing changes; use `mise run fix` for formatting or lint fixes, then correct remaining failures.

Every extension lives in `packages/<slug>` and owns its runtime dependencies, pi manifest, README, license, version, and changelog. The root package is private. Keep packages independently installable and releasable; never import a sibling's source through relative paths.

Put portable automation behind mise tasks. Workflows own GitHub events, permissions, credentials, environments, and platform API calls. Keep release tags immutable and publish from their original monorepo commits.

Record repository-wide architectural decisions in `docs/adrs/`. Keep accepted historical package ADRs unchanged; supersede them when decisions change.
