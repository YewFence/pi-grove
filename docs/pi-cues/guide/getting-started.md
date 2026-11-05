# Getting started

Install the npm package with `pi install npm:pi-cues`. For a local pi-grove checkout, use `pi install ./packages/cues`.

Create global configuration at `~/.pi/agent/extensions/pi-cues/config.toml`, or project configuration at `.pi/extensions/pi-cues/config.toml`. The global root follows `PI_CODING_AGENT_DIR` when set. Project configuration runs only for trusted projects. See the package README for the trigger configuration reference and `/cues status` for diagnostics and the installed schema path.

## Actions at a glance

| Action | When it lands | What the target is | Typical use |
|---|---|---|---|
| `skill` | with the matching tool result | skill name | load a skill's full text on first `jj` call |
| `file` | with the matching tool result | prompt file path | load a conventions document on first touch |
| `walkup` | with the matching tool result | context file names | collect `AGENTS.md` up to the session cwd |
| `inline` | with the matching tool result | the text itself | one-line habit corrections |
| `exec` | with the matching tool result | shell command | inject a subcommand's `--help` |
| `confirm` | **before** the call executes (first match per session) | the prompt text | "use the host proxy before you `docker build`" |

`confirm` is the odd one out: instead of appending context to a finished result, it blocks the first matching call and hands the target text to the model as the block reason. The model reads it, adjusts the command if needed, and re-issues — the retry runs normally. The builtin prompt frame states the call was not executed, is not a permission denial, and may be retried; override it once in the global config with `[confirm] template = "… {target} …"`.
