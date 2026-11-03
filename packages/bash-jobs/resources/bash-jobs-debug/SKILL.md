---
name: bash-jobs-debug
description: If hook stderr gives a clear fix, apply it directly. Read this skill only if the fix fails or the cause remains unclear, to understand bash-jobs environment hooks and diagnose persistent failures.
---

# Diagnose persistent environment hook failures

Start with the hook's stderr and the requested command's result. When stderr gives a clear fix, apply it within the user's authorized scope and check whether the hook recovers on the next bash call. Use the steps below when that fix fails or the cause remains unclear.

## Understand the two stages

Before each bash call, bash-jobs runs the configured hook commands to generate initialization code. A successful hook's stdout becomes bash code, such as `export` and `unset`. After collecting the successful outputs, bash-jobs runs that code in declaration order under `set -e`, then runs the requested command.

A `source-hook` envelope with `outcome="failed"` means generation failed: that hook's stdout was discarded, other hooks and the requested command continue. Check the requested command's own result before retrying it. It may already have changed files or completed another operation.

An `outcome="warning"` envelope means generation exited with code 0 and wrote to stderr. The generated code proceeds to initialization; the warning alone does not establish that the environment is degraded or that initialization has already succeeded.

Initialization code that fails under `set -e` can prevent the requested command from running. That failure appears in the bash result. Diagnose whether the error occurred during generation, initialization, or the requested command before choosing a fix.

## Inspect the active configuration

Read `<agent-dir>/extensions/pi-bash-jobs/config.toml`. Resolve `<agent-dir>` from `PI_CODING_AGENT_DIR`, or use `~/.pi/agent` when unset. Only this user configuration is loaded; project configuration is not read. Configuration changes require `/reload`, while hook commands and scripts execute afresh on each bash call.

The TOML uses `version = 1` and ordered `[[source_hooks]]` tables:

- `name` identifies the hook in diagnostic envelopes.
- `command` is an argv array, started directly without shell expansion. Use an explicit shell invocation or a script for shell syntax.
- `timeout_ms` defaults to 3000. Generation stdout is limited to 1 MiB; stderr capture is limited to 8 KiB and diagnostic envelopes may truncate it further.
- `quiet` defaults to `false` and controls failure reporting. When true, failures and recovery produce user notifications instead of model diagnostics.
- `report_stderr_on_success` defaults to `true` and independently controls successful stderr reporting.

Each generator runs in the bash call's working directory with its initial environment. Relative script paths resolve from that working directory. Generators do not inherit earlier hooks' generated environment updates. Their outputs are subsequently applied in order within the requested command's shell. Put dependent generation steps in one script.

## Isolate the failing stage

1. Match the envelope's hook name to its configuration. Check executable availability, argv boundaries, working directory, relative paths, timeout, and stderr.
2. If needed, run the configured generator directly in that directory, capturing stdout, stderr, and exit status separately. Each bash tool invocation also runs the configured hooks, so distinguish the outer hook envelope from this explicit generator run.
3. Inspect generated stdout as shell code when generation succeeds. Keep logs and progress on stderr. Avoid executing generated code merely to inspect it, and avoid displaying secrets that initialization scripts may export.
4. Fix the generator or its underlying environment configuration using the observed failure. A repeated missing executable or missing directory is retried on subsequent calls. Cancellation terminates the current command hook and its process tree and stops later initialization.
5. Verify recovery with a small environment probe appropriate to the issue. For a known failed command that is safe to repeat, retry only after checking whether it previously executed. Long preparation may have moved the invocation into a background job; collect its result through `bash_wait` first.

Report the observed cause, the change made, and verification. If resolving the issue needs a permission or decision outside the user's authorization, explain the specific blocker.
