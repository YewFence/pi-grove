# pi-grove

Personal collection of extensions for the [pi coding agent](https://pi.dev), written and maintained by YewFence.

| Package                                                     | Purpose                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| [`pi-cues`](packages/cues)                                  | Deterministic context injection, skills, and project conventions |
| [`@pi-grove/bash-jobs`](packages/bash-jobs)                 | Background bash jobs, output polling, and job controls           |
| [`@pi-grove/edit-diagnostics`](packages/edit-diagnostics)   | Useful diagnostics for failed exact edits                        |
| [`@pi-grove/ask-user-question`](packages/ask-user-question) | Structured questionnaires with inline previews                   |

Install individual packages with `pi install npm:<package-name>` after their first npm release. During local development, install `./packages/<slug>` from the repository checkout. The workspace root is private and does not load extensions.

Development guides and design records live under [docs](docs), which CI publishes as a documentation site. See [development and releases](docs/development.md) for the repository workflow and the [monorepo ADRs](docs/adrs/0001-independent-packages.md) for cross-package decisions. Historical pi-cues architecture decisions remain under [pi-cues ADRs](docs/pi-cues/adrs/index.md).

## Development

```bash
mise trust
mise install
mise run deps:install
mise run check
```

Each package has its own version, changelog, release PR, and npm publication. See [the development guide](docs/development.md) for migration, release operations, and initial repository setup. Contribution basics are in [CONTRIBUTING](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE) and each package's own license. `pi-cues` additionally carries a [NOTICE](packages/cues/NOTICE) for code adapted from pi-rules and pi-mention-skill.
