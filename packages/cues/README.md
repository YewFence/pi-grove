# pi-cues

[![Release](https://img.shields.io/github/v/tag/YewFence/pi-grove?filter=cues-v*&sort=semver)](https://github.com/YewFence/pi-grove/releases)
[![Docs](https://img.shields.io/badge/docs-online-blue)](https://YewFence.github.io/pi-grove/)
[![License](https://img.shields.io/github/license/YewFence/pi-grove)](LICENSE)

Deterministic context loading for the pi coding agent: a central trigger table maps bash commands and tool-operated file paths to skills and prompt files

> [!NOTE]
> This project is in an early development stage. Core features may be missing, and backward compatibility is not guaranteed.

## Quick Start

### Installation

Install the published package:

```bash
pi install npm:pi-cues
```

For a local pi-grove checkout, run `pi install ./packages/cues`. Development and release tasks run from the monorepo root; see [the development guide](../../docs/development.md).

### Configuration

Editor validation and autocomplete for the config file (Taplo, Even Better TOML) via the shipped JSON Schema — `/cues status` prints the exact path of the copy inside your installed package:

```toml
#:schema /path/from/cues-status/config.schema.json

version = 1
```

The schema is generated from the `RawConfig` types in `src/piCues/types.ts`; `tests/schema.test.ts` fails when the two drift apart.

Create `.pi/extensions/pi-cues/config.toml` in your project, or `~/.pi/agent/extensions/pi-cues/config.toml` globally (`PI_CODING_AGENT_DIR` overrides `~/.pi/agent`) — same relative path, different root; the two are appended, global baseline first. The location under `extensions/` is deliberate: in a project, that directory is one of pi's trust-requiring resources, so pi asks for project trust before a cloned repository can ship any pi-cues config, and an untrusted project's config is withheld:

```toml
version = 1

# Running `jj ...` loads the jj-cli skill once per session
[[triggers]]
tools = ["bash"]
when.command = "jj"
action = "skill"
target = "jj-cli"

# Reading or editing a test file injects a prompt file (relative to the config directory)
[[triggers]]
tools = ["read", "edit"]
when.path = "src/**/*.test.ts"
action = "file"
target = "./triggers/vitest.md"

# Running `jj ...` reminds the agent of a one-line convention — no file needed
[[triggers]]
tools = ["bash"]
when.command = "jj"
action = "inline"
target = "Write commit messages in Chinese."

# Running `jj ...` runs a command and injects its output — the classic case
# is pulling the exact help text of the subcommand in play. when.command
# matches subcommands too: "jj edit" only fires for `jj edit …`, while bare
# "jj" still matches every jj invocation. The output lands in a
# <command-output command="..."> block; when it is truncated, the model is
# told to re-run the command. The command runs inside the tool
# result, so keep it fast: it adds its own runtime to the bash call.
[[triggers]]
tools = ["bash"]
when.command = "jj edit"
action = "exec"
target = "jj edit --help"

# Any path operation walks up to the session cwd collecting context files
[[triggers]]
tools = ["read", "edit", "write"]
action = "walkup"
target = ["AGENTS.md", "CLAUDE.md"]

# Walkup can drop collected files by pattern: matched against the collected
# file's path relative to the session cwd (POSIX separators). "README.md"
# matches only the cwd-level file; a globstar pattern matches any depth.
exclude = ["README.md"]
```

Each target fires at most once per session (reset on compaction). Every firing pops a toast notification (`pi-cues: injected jj-cli (skill)`, or a warning when the target failed to load), so injections are visible as they happen instead of staying buried in the tool result block. `/cues status` shows the loaded config, diagnostics, and what has fired.

Every fired cue is also appended to `~/.cache/pi-cues/events.jsonl` (one JSON line per event: timestamp, pi session id, action, target, source, and whether it loaded) so you can confirm pi-cues is working after the session is gone — `tail -f` it while you work. The file rotates to `events.jsonl.1` past 2 MiB. Local only, never sent anywhere; opt out in the global config:

```toml
version = 1

[telemetry]
enabled = false
```

Project-level `[telemetry]` entries are ignored: telemetry is the machine owner's knob, not a cloned repository's.

Out of the box, pi-cues ships one builtin trigger: every read/edit/write walks up to the session cwd collecting `AGENTS.md` (deduplicated against pi's natively loaded context files). Add `defaults = false` to any config file to disable it.

Walk-up collection — builtin and configured — only runs for projects with an explicit trusted decision in pi's `trust.json` (`/trust` records one). Undecided and declined projects collect nothing: pi's `isProjectTrusted()` reports true for projects without trust-requiring resources regardless of saved decisions (see [pi#10947](https://github.com/earendil-works/pi/issues/10947)), so the store file is the only reliable source. `/cues status` shows the current walk-up trust state.

The package also bundles the `pi-cues-authoring` skill, which teaches the agent how to author context for pi-cues (form choice, location-as-scope, wiring discipline).

Security: project config loads only when the project is trusted (pi's project trust); project `file` targets must stay inside the config directory; walk-up never fires for files outside the session cwd. `exec` targets run as literal shell commands with your user permissions in pi's bash shell — a trusted project's config can therefore run anything you can, so treat an unfamiliar project's `exec` triggers the way you treat its build scripts. The command is awaited inside the tool result, so a slow one lengthens that bash call; keep `exec` targets to fast commands such as `--help`. Every injection is wrapped in a `<pi-cues action=… trigger=…>…</pi-cues>` envelope whose first line states it is injected context rather than tool output, and the system prompt gains [one line per session](https://github.com/YewFence/pi-grove/blob/main/packages/cues/src/piCues/index.ts#L138) describing the envelope.

## Development

```bash
mise run check
mise run test
```

See the [Contributing Guide](../../CONTRIBUTING.md) for the complete development workflow.

## Documentation

See the [documentation site](https://YewFence.github.io/pi-grove/) for setup, usage, and configuration guidance.

## Contributing

If you have suggestions or find a bug, please [open an issue](https://github.com/YewFence/pi-grove/issues).

Pull requests are welcome. See the [Contributing Guide](../../CONTRIBUTING.md).

## Why pi-cues

I kept running into the same failure, and it was never a model being stupid — it was me expecting natural-language instructions to behave like guarantees. Tell a model to run `jj --help` before using `jj`, and it usually will; ask it to load the `jj-cli` skill it can see listed, and it often won't; drop an `AGENTS.md` into a subdirectory, and whether it gets read depends on how the session feels that day. Every one of those instructions is a request, and a request is a coin flip I get to lose at the worst possible moment — usually right after I've stopped paying attention. The fix is not a better request.

Firefox's [`review-context.toml`](https://github.com/mozilla-firefox/firefox/blob/main/review-context.toml) pointed at the way out: bind context to a deterministic predicate — a file path, a command — instead of to the model's goodwill. So this is that idea, moved onto the two signals a pi session already produces: the bash commands the agent runs and the paths it touches. `jj log` fires the jj skill, an edit to `**/*.test.ts` fires the Vitest conventions, the `AGENTS.md` above the file gets collected on the way in. Write the trigger once and it fires every single time, because nothing about it depends on the model remembering anything: the rule either matches or it does not, and a match always injects. That is the whole point — context you configured stops being context you hope for.

## Acknowledgments

pi-cues' design is inspired by Firefox's [review-context.toml](https://github.com/mozilla-firefox/firefox/blob/main/review-context.toml), which loads review context through deterministic predicates (see [bugbug's design doc](https://github.com/mozilla/bugbug/blob/master/docs/code-review-skills.md)). The implementation references [pi-rules](https://github.com/code-yeongyu/pi-rules) (MIT, © Yeongyu Kim): the glob matcher, truncation budget, walk-up traversal, session dedup pattern, and the `tool_result` injection contract are adapted from its source. The skill `<skill>` block format and frontmatter stripping come from [pi-mention-skill](https://github.com/zigai/pi-extensions) (MIT, © zigai). See [NOTICE](NOTICE) for details.

## License

[MIT License](LICENSE)
