# 0003: Use Vitest for all tests

Status: Accepted.

## Context

Imported extensions retained different test runners. Maintaining both Vitest and Node's test runner duplicates lifecycle, mocking, reporting, and subprocess conventions across one development workspace.

## Decision

Use Vitest for extension tests and root release automation tests. Each package owns its test script and configuration so it remains independently testable. The root configuration discovers only release automation tests, and the mise test task runs package suites before the root suite. Keep existing assertions, test isolation, cleanup, timeouts, and subprocess regression coverage when migrating runners.

## Consequences

New packages use Vitest. Runner-specific subprocess tests invoke the Vitest CLI and inspect structured results. Runtime dependencies and package release boundaries remain package-local.
