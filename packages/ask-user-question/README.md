# @pi-grove/ask-user-question

A structured questionnaire for pi with single and multiple selection, custom answers, notes, collapsible dialogs, and Markdown previews. The tool name remains `ask_user_question`.

After publication, install with `pi install npm:@pi-grove/ask-user-question`. For a local checkout, install this package directory. Configuration is optional and read from `~/.pi/extensions/ask-user-question/config.json`:

```json
{
  "maxQuestions": 0,
  "collapseKey": "ctrl+]",
  "guidance": {
    "description": "Ask the user structured questions when a decision is needed."
  }
}
```

`maxQuestions` defaults to four; zero removes the maximum. `collapseKey` defaults to `ctrl+]`; `off` disables it. `guidance.description`, `guidance.promptSnippet`, and `guidance.promptGuidelines` override the model-facing text. Invalid fields use their defaults; malformed files produce a warning. Changes take effect after restarting pi.

The UI uses English. Configuration and internationalization no longer depend on the upstream rpiv packages. This fork was extracted from juicesharp's MIT-licensed rpiv-mono questionnaire at 2.12.0; the original copyright is retained in LICENSE. Its independent pi-grove version begins at 0.1.0. Public event contracts remain available through the `./events` export.

Run checks from the pi-grove root with `mise run check`. Keyboard, host, and tool schema details are in this package's `docs/` directory.
