# Development and releases

Use mise and aube throughout the workspace. Run `mise trust`, `mise install`, and `mise run deps:install`, then `mise run check`. `mise run fix` formats code and applies lint fixes. All tests use Vitest, and every package has test and typecheck tasks. Package-local Vitest configurations keep each extension's tests independent; the root configuration runs release automation tests.

The shared TypeScript configuration enables strict indexed access, override, and isolated-module checks. `mise run check` also checks spelling, final newlines, tracked files for secrets, formatting, workflow configuration, immutable Action pins, package loading, and the documentation build. `mise run fix` updates the dependency lockfile and applies whitespace, spelling, formatting, and lint fixes. Review the resulting edits, especially intentional test strings.

Run `mise run audit` to check dependency advisories. The Security Audit workflow runs on dependency changes and weekly. `mise run actions:pin:check` verifies Action pins online, including a three-day release age; its workflow runs on main updates and weekly. Local `mise run actions:check` remains offline. All workflows have explicit timeouts; publishing disables tool-cache restoration and grants write permissions only to the jobs that need them.

The root dependency overrides use patched glob and minimatch versions for schema generation while ts-json-schema-generator still declares glob 13. Remove these overrides once its dependency range includes patched versions. After updating them, regenerate the pi-cues schema and compare its parsed JSON with the committed schema.

## Repository checks

`mise run check` verifies dependency locks, tracked-file newlines, spelling, formatting, TypeScript types, lint rules, workflow pins, secrets, tests, package loading, and the documentation build. All packages inherit `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, and `isolatedModules` from the root TypeScript configuration. `mise run fix` regenerates the dependency lockfile and applies newline, spelling, formatting, and lint fixes.

`mise run audit` checks dependencies against registry advisories. Security Audit runs on dependency changes and weekly. Development-only overrides keep the schema generator's glob and minimatch dependencies on patched versions until its dependency ranges catch up.

`mise run actions:check` uses jactionlint and an offline SHA pin check. `mise run actions:pin:check` verifies pins online, including the three-day release age; provide `PINACT_GITHUB_TOKEN` for authenticated requests. Action Pinning runs on main updates and weekly. Workflows own credentials and permissions; reusable checks stay behind mise tasks.

`mise run leaks:check` scans tracked files with redacted output in both jj workspaces and Git checkouts, including committed code in CI. Local environment files and mise overrides are ignored by version control. Git hooks are not installed.

## Independent packages

Each `packages/<slug>` directory owns a package manifest, source, tests, license, README, version, and changelog. Runtime dependencies belong in that package. Pi host packages and TypeBox are peers; the root pins their development versions. Add future extensions under `packages/*` and define `test` and `typecheck` scripts; package discovery and release workflows need no package list edits.

Packages publish TypeScript source, which pi loads through its extension loader. `mise run package:check` packs each extension, checks its declared resources, and loads the unpacked extension with pi. This covers resources beyond TypeScript modules, including pi-cues skills and its schema.

## Release preparation

Main branch updates automatically run Prepare Release; you can also run the workflow with a package directory slug or `all`. It computes independent plans, creates one release branch and PR per changed package, and explicitly dispatches CI for bot-created branches. Merge only the package PRs you want to release. Keep the workflow's concurrency serialization so two preparations cannot race on the same release branch.

Versions and notes come from git-cliff, filtered by package paths and tags such as `cues-v0.3.0`. Conventional commits control bumps; before 1.0, breaking changes bump minor. A commit touching two packages affects both; a root-only toolchain change triggers checks without automatically bumping all packages. Root lockfile changes that alter an extension's effective runtime dependencies should accompany a package manifest change or an explicit package release decision.

`pi-grove-import` marks the import baseline. Existing pi-cues history and its old `v0.1.0` tag remain intact; the first monorepo pi-cues release is `cues-v0.3.0`, retaining the imported package version and its existing agent-directory configuration path. Other packages begin at their own `0.1.0` releases. Historical imported work is not replayed into new release notes.

Josh filters `:/packages/<slug>` to compare the release base with the main parent of the release commit. Sibling changes leave the fingerprint unchanged. New commits in the package, even if later reverted, require refreshing its release PR. Release PRs may change only the target manifest version, changelog, and workspace lockfile. Use squash merges or ordinary merge commits; do not rebase-merge release PRs because validation relies on their first parent representing main before the release.

Portable tasks are also available locally:

```bash
mise run release:plan cues --output /tmp/cues-plan.json
mise run release:prepare /tmp/cues-plan.json
mise run release:validate cues-v0.3.0 --base <prepared-base-sha>
mise run release:publish cues-v0.3.0 --dry-run
```

Preparation edits local release files. Publishing requires checking out the exact existing tag. The publish task verifies package resources, checks whether that exact name/version already exists, and publishes with npm provenance. Prereleases use the `next` dist-tag; stable releases use `latest`. Package jobs serialize by package. Retry a failed publication through the Release workflow's existing tag input; versions are immutable and existing versions are verified and skipped.

## Repository and npm setup

Create the GitHub repository `YewFence/pi-grove` and npm organization `pi-grove`. Enable Actions to create pull requests and allow workflow dispatch, enable GitHub Pages with Actions as its source, and configure the `npm` environment. Configure npm trusted publishing for each package with this repository and `release.yml`; transfer the existing pi-cues trusted publisher binding to the new repository. New package names may require an initial bootstrap publication before npm allows configuring trusted publishing. Local checks never publish to npm or create remote PRs.

## Configuration migration

pi-cues retains global configuration and referenced relative files under `<agent-dir>/extensions/pi-cues/`, where `<agent-dir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent` by default. Project pi-cues configuration stays in `.pi/extensions/pi-cues/`, and host trust data stays in the agent directory. The monorepo import does not require moving pi-cues configuration.

Move questionnaire settings from `~/.config/rpiv-ask-user-question/config.json` to `~/.pi/extensions/ask-user-question/config.json`. The supported fields remain `maxQuestions`, `collapseKey`, and `guidance`. Upstream config helpers, XDG fallback, language integration, and locale files are removed. The UI uses English. Existing MIT attribution remains in the package license.
