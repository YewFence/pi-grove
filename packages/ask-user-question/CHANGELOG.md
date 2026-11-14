## What's Changed in ask-user-question-v0.1.0

- reset fork changelog and record upstream attribution
- harden TypeScript and repository checks

# Changelog

All notable changes to `@pi-grove/ask-user-question` are documented here. The package forked from [`@juicesharp/rpiv-ask-user-question` at `v2.12.0`](https://github.com/juicesharp/rpiv-mono/tree/v2.12.0/packages/rpiv-ask-user-question); upstream history before the fork is not repeated here — see the [upstream changelog](https://github.com/juicesharp/rpiv-mono/blob/v2.12.0/packages/rpiv-ask-user-question/CHANGELOG.md).

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `maxQuestions` can now set the maximum number of questions per `ask_user_question` call. It defaults to `4`; setting it to `0` removes the limit. The registered TypeBox schema, runtime validation, and built-in model guidance all use the resolved value.
- A committed note now stays visible on its question tab as a dim `Notes: <text>` line below the options after the editor closes — no need to press `n` again to check what you wrote. The echo hides while the editor is open (the editor is the live surface then) and localizes with the rest of the chrome.

### Changed

- **The answered envelope is one line per question, keyed by `header` (`Auth method="JWT"`), instead of a single prose line quoting each full question.** The model authored the question text itself, so echoing it added length without information; the per-line shape keeps both the model-facing text and the transcript scannable. Per-question notes still ride as a `user notes: <text>` suffix and the global note as a trailing `global note: <text>` line; decline semantics and `details` are unchanged. An empty header falls back to `Q<n>`, matching the Submit-tab review.

## [0.1.0] - 2026-11-03

Initial fork from `@juicesharp/rpiv-ask-user-question` [`v2.12.0`](https://github.com/juicesharp/rpiv-mono/tree/v2.12.0/packages/rpiv-ask-user-question) (MIT). The fork drops the rpiv i18n and guidance package dependencies and carries its own configuration; upstream copyright is retained in LICENSE and the fork origin is recorded in NOTICE.
