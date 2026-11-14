# Getting started

Install the npm package with `pi install npm:pi-cues`. For a local pi-grove checkout, use `pi install ./packages/cues`.

Create global configuration at `~/.pi/agent/extensions/pi-cues/config.toml`, or project configuration at `.pi/extensions/pi-cues/config.toml`. The global root follows `PI_CODING_AGENT_DIR` when set. Project configuration runs only for trusted projects. See the package README for the trigger configuration reference and `/cues status` for diagnostics and the installed schema path.

## Actions and policies at a glance

| Action | What the target is | Typical use |
|---|---|---|
| `skill` | skill name | load a skill's full text on first `jj` call |
| `file` | prompt file path | load a conventions document on first touch |
| `walkup` | context file names | collect `AGENTS.md` up to the session cwd |
| `inline` | the text itself | one-line habit corrections |
| `exec` | shell command | inject a subcommand's `--help` |

Every action lands with the matching tool result; the orthogonal `policy` knob picks how often (default `once`):

| Policy | Behavior |
|---|---|
| `once` | inject after the first matching call per session |
| `repeat` | inject after every matching call — an `exec` cue re-runs its command each time |
| `confirm` | block the first matching call **before** it executes and hand the target text over as the block reason (pairs with `action = "inline"` only) |

`confirm` is the odd one out: instead of appending context to a finished result, it blocks the first matching call and hands the target text to the model as the block reason. The model reads it, adjusts the command if needed, and re-issues — the retry runs normally. The builtin prompt frame states the call was not executed, is not a permission denial, and may be retried; override it once in the global config with `[confirm] template = "… {target} …"`.
