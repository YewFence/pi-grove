import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadSourceHookConfig } from "../src/config.ts";
import { isolateTestEnvironment } from "./helpers/environment.ts";

function setup(t: TestContext) {
  const { agentDir, cwd } = isolateTestEnvironment(t);
  const dir = join(agentDir, "extensions", "pi-bash-jobs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.toml");
  return { file, cwd, write: (text: string) => writeFileSync(file, text) };
}

test("absent user config has no hooks and ignores project config", (t) => {
  const { cwd } = setup(t);
  const project = join(cwd, ".pi", "extensions", "pi-bash-jobs");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "config.toml"),
    'version = 1\n[[source_hooks]]\nname = "project"\ncommand = ["false"]',
  );
  assert.deepEqual(loadSourceHookConfig(), { hooks: [], diagnostics: [] });
});

test("loads ordered commands from PI_CODING_AGENT_DIR with a default timeout", (t) => {
  const { write } = setup(t);
  write(
    'version = 1\n[[source_hooks]]\nname = "first"\ncommand = ["custom", "", "two words"]\n[[source_hooks]]\nname = "second"\ncommand = ["other"]\ntimeout_ms = 5000',
  );
  assert.deepEqual(loadSourceHookConfig(), {
    hooks: [
      {
        name: "first",
        command: ["custom", "", "two words"],
        timeoutMs: 3000,
        quiet: false,
        reportStderrOnSuccess: true,
      },
      {
        name: "second",
        command: ["other"],
        timeoutMs: 5000,
        quiet: false,
        reportStderrOnSuccess: true,
      },
    ],
    diagnostics: [],
  });
});

test("quiet is explicitly configurable", (t) => {
  const { write } = setup(t);
  write('version = 1\n[[source_hooks]]\nname = "quiet"\ncommand = ["custom"]\nquiet = true');
  assert.deepEqual(loadSourceHookConfig().hooks, [
    {
      name: "quiet",
      command: ["custom"],
      timeoutMs: 3000,
      quiet: true,
      reportStderrOnSuccess: true,
    },
  ]);
});

test("successful stderr reporting is independently configurable", (t) => {
  const { write } = setup(t);
  write(
    'version = 1\n[[source_hooks]]\nname = "custom"\ncommand = ["custom"]\nquiet = false\nreport_stderr_on_success = false',
  );
  assert.deepEqual(loadSourceHookConfig().hooks, [
    {
      name: "custom",
      command: ["custom"],
      timeoutMs: 3000,
      quiet: false,
      reportStderrOnSuccess: false,
    },
  ]);
});

test("malformed TOML and unsupported versions produce file diagnostics", (t) => {
  const { write, file } = setup(t);
  for (const text of ["version = [", "version = 2"]) {
    write(text);
    const result = loadSourceHookConfig();
    assert.deepEqual(result.hooks, []);
    assert.equal(result.diagnostics.length, 1);
    assert.ok(result.diagnostics[0]!.includes(file));
  }
});

test("invalid hook entries are skipped while valid entries remain active", (t) => {
  const { write, file } = setup(t);
  const entries = [
    'name = ""\ncommand = ["ok"]',
    'name = "bad-command"\ncommand = "bad"',
    'name = "bad-timeout"\ncommand = ["ok"]\ntimeout_ms = 0',
    'name = "bad-quiet"\ncommand = ["ok"]\nquiet = "true"',
    'name = "bad-report-stderr"\ncommand = ["ok"]\nreport_stderr_on_success = "false"',
    'name = "unknown-key"\ncommand = ["ok"]\ntimeout = 1',
    'name = "valid"\ncommand = ["ok"]',
  ];
  write("version = 1\n" + entries.map((entry) => `[[source_hooks]]\n${entry}\n`).join(""));
  const result = loadSourceHookConfig();
  assert.deepEqual(result.hooks, [
    { name: "valid", command: ["ok"], timeoutMs: 3000, quiet: false, reportStderrOnSuccess: true },
  ]);
  assert.equal(result.diagnostics.length, 6);
  result.diagnostics.forEach((message, index) =>
    assert.ok(message.includes(`${file}: source_hooks[${index}]`)),
  );
});
