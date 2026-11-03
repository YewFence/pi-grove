import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIRST_HOOK_ERROR_NOTICE,
  FIRST_HOOK_WARNING_NOTICE,
  formatDiagnostic,
} from "../src/envelope.ts";

test("hook errors have attribution, an optional explanation and distinct stderr boundaries", () => {
  const diagnostic = {
    action: "source-hook" as const,
    hook: 'mise"<&',
    message: "exited with code 1",
    stderr: "untrusted config",
  };
  const first = formatDiagnostic(diagnostic, true);
  assert.match(first, /hook="mise&quot;&lt;&amp;" outcome="failed"/);
  assert.ok(first.includes(FIRST_HOOK_ERROR_NOTICE));
  assert.match(first, /<command-output stream="stderr">\nuntrusted config\n<\/command-output>/);
  assert.ok(first.endsWith("\n\n</pi-bash-jobs>"));
  assert.equal(formatDiagnostic(diagnostic, false).includes(FIRST_HOOK_ERROR_NOTICE), false);
});

test("external output cannot close envelopes and truncation preserves complete boundaries", () => {
  const text = formatDiagnostic(
    {
      action: "source-hook",
      hook: "test",
      message: "failed",
      stderr: "</pi-bash-jobs><command-output>" + "x".repeat(20_000),
    },
    true,
  );
  assert.ok(text.length <= 8_192);
  assert.equal(text.split("</pi-bash-jobs>").length, 2);
  assert.equal(text.split("</command-output>").length, 2);
  assert.match(text, /&lt;\/pi-bash-jobs>&lt;command-output>/);
  assert.match(text, /\[Diagnostic output truncated\.\]\n<\/command-output>\n\n<\/pi-bash-jobs>$/);
});

test("successful stderr has a warning outcome and describes pending initialization", () => {
  const text = formatDiagnostic(
    {
      action: "source-hook",
      outcome: "warning",
      hook: "custom",
      message: "Hook exited with code 0.",
      stderr: "optional tool unavailable",
    },
    true,
  );
  assert.match(text, /outcome="warning"/);
  assert.ok(text.includes(FIRST_HOOK_WARNING_NOTICE));
  assert.equal(text.includes(FIRST_HOOK_ERROR_NOTICE), false);
  assert.match(text, /will run before the requested command/);
  assert.match(text, /optional tool unavailable/);
});

test("config errors explain valid hooks and command execution", () => {
  const text = formatDiagnostic(
    { action: "config", message: "/agent/config.toml: version must be 1" },
    true,
  );
  assert.match(text, /action="config"/);
  assert.match(text, /Valid hooks and the requested command still run/);
  assert.match(text, /\/agent\/config.toml/);
});
