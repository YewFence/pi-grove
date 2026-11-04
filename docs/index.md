# pi-grove

Personal collection of extensions for the [pi coding agent](https://pi.dev), written and maintained by YewFence.

| Package | Purpose |
| --- | --- |
| `pi-cues` | Deterministic context injection, skills, and project conventions |
| `@pi-grove/bash-jobs` | Background bash jobs, output polling, and job controls |
| `@pi-grove/edit-diagnostics` | Useful diagnostics for failed exact edits |
| `@pi-grove/ask-user-question` | Structured questionnaires with inline previews |
| `pi-usage` | Coding-time observability exported as OTLP spans to your stack |

Install individual packages with `pi install npm:<package-name>` after their first npm release. During local development, install `./packages/<slug>` from the repository checkout. The workspace root is private and does not load extensions.

See [development and releases](./development.md) for the repository workflow. Historical pi-cues architecture decisions remain under [pi-cues ADRs](./pi-cues/adrs/index.md). The pi-usage design notes live at [`pi-usage/design.md`](./pi-usage/design.md).
