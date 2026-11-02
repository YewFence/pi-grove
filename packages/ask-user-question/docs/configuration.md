# Configuration

The optional file is `~/.pi/extensions/ask-user-question/config.json`. It is read when the extension registers. The former XDG and rpiv configuration paths are not read.

| Field | Default | Accepted values |
| --- | --- | --- |
| `maxQuestions` | `4` | Nonnegative safe integer; `0` means unlimited |
| `collapseKey` | `ctrl+]` | Pi key specification, or `off` |
| `guidance.description` | Built-in tool description | Nonempty string |
| `guidance.promptSnippet` | Built-in prompt snippet | Nonempty string |
| `guidance.promptGuidelines` | Built-in guidelines | Nonempty array of nonempty strings |

Malformed JSON warns and uses defaults. Valid non-object JSON uses defaults. Invalid fields use their respective defaults. No language configuration is available; the UI uses English.
