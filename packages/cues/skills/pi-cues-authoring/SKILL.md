---
name: pi-cues-authoring
description: Author context that pi-cues loads — AGENTS.md files, prompt files, inline cues, and the triggers that wire them. Use when writing or editing AGENTS.md or other repository context files, editing a pi-cues `config.toml`, adding project conventions, or auditing context wiring.
---

# pi-cues authoring

A **cue** is a deterministic link: trigger fires, content lands in context. pi-cues only knows how to fire cues; this skill is how you author content worth firing.

## Choose the form first

Length and judgment pick the form — decide before writing:

- One sentence → `action = "inline"`, the target is the text itself
- A paragraph or list of conventions → `action = "file"` plus a standalone `.md`
- Always relevant, always resident → `AGENTS.md` (the builtin walkup cue already covers it; no trigger to write)
- The right moment depends on context only the model can judge → a SKILL, whose description does the routing; cues carry deterministic triggers only

## Three principles

1. **Single source of truth.** Write knowledge once; let triggers deliver it. Reference by link. Injection is deduped per session, but nobody dedupes _content_ — two independently rotting copies are worse than one.
2. **Location is scope.** Root `AGENTS.md` is always-resident — the most expensive tier, so keep it lean. A subdirectory `AGENTS.md` is component-scoped, loaded on first touch. When unsure, place deeper; several deep files beat one thick root file.
3. **Wiring discipline.** A `.md` without a trigger is a dead document — written, never loaded. Form and trigger land together or not at all. (Not every document needs a cue: docs meant for humans, or content pi already loads natively, stand on their own.)

## Adding a piece of context

1. Pick the form per "Choose the form first". Done when: you can say why the lighter form was insufficient.
2. Place it at the deepest directory whose scope it serves. Done when: the path itself states the scope.
3. Wire the trigger in the project config (`.pi/extensions/pi-cues/config.toml`) or the global one (`~/.pi/agent/extensions/pi-cues/config.toml`) — skip for `AGENTS.md`, the builtin walkup has it. Done when: the `when` predicate matches the real firing situation, nothing broader.
4. Verify with `/cues status` or by firing the trigger once. Done when: the status shows a ✓ record for your target.

## Maintaining

- When you edit a context file, check the triggers referencing it in the same pass — globs and paths drift silently.
- Occasionally audit both directions: every `file` target in the pi-cues config still exists, and every context `.md` in the repo has an owner (a trigger, the builtin walkup, or pi itself).
