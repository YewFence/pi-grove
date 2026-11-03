import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HookDiagnostic } from "../src/envelope.ts";
import { createCommandSourceHook } from "../src/source-hooks.ts";

function fixture(script: string, timeoutMs = 2_000, quiet = false, reportStderrOnSuccess = true) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-source-hook-"));
  const path = join(cwd, "hook.cjs");
  writeFileSync(path, script);
  return {
    cwd,
    path,
    hook: createCommandSourceHook({
      name: "custom",
      command: [process.execPath, path, "$(touch injected)", ""],
      timeoutMs,
      quiet,
      reportStderrOnSuccess,
    }),
  };
}

test("command hook preserves argv, cwd and environment and returns only stdout", async () => {
  const { cwd, hook } = fixture(`
    console.error('diagnostic');
    process.stdout.write(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), value: process.env.HOOK_INPUT}));
  `);
  const result = await hook.sourceCode({ cwd, env: { ...process.env, HOOK_INPUT: "inherited" } });
  assert.deepEqual(JSON.parse(result!), {
    args: ["$(touch injected)", ""],
    cwd,
    value: "inherited",
  });
  assert.equal(existsSync(join(cwd, "injected")), false);
});

test("failed hooks discard partial stdout and notify only on failure and recovery transitions", async () => {
  const { cwd, path, hook } = fixture(
    "process.stdout.write('export PARTIAL=1'); process.exit(2)",
    2_000,
    true,
  );
  const notices: string[] = [];
  const ctx = { cwd, notify: (message: string) => notices.push(message) };
  assert.equal(await hook.sourceCode(ctx), undefined);
  assert.equal(await hook.sourceCode(ctx), undefined);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /exited with code 2/);
  writeFileSync(path, "process.stdout.write('export READY=1')");
  assert.equal(await hook.sourceCode(ctx), "export READY=1");
  assert.equal(await hook.sourceCode(ctx), "export READY=1");
  assert.equal(notices.length, 2);
  assert.match(notices[1]!, /recovered/);
});

test("default failures report bounded stderr every time and successful stderr becomes a warning", async () => {
  const { cwd, path, hook } = fixture("console.error('x'.repeat(20000)); process.exit(3)");
  const reports: Array<{ message: string; stderr?: string }> = [];
  const notices: string[] = [];
  const ctx = {
    cwd,
    report: (diagnostic: { message: string; stderr?: string }) => reports.push(diagnostic),
    notify: (message: string) => notices.push(message),
  };
  await hook.sourceCode(ctx);
  await hook.sourceCode(ctx);
  assert.equal(reports.length, 2);
  assert.match(reports[0]!.message, /exited with code 3/);
  assert.ok(reports[0]!.stderr!.length < 8300);
  assert.match(reports[0]!.stderr!, /truncated/);
  writeFileSync(path, "console.error('successful stderr'); process.stdout.write('export OK=1')");
  assert.equal(await hook.sourceCode(ctx), "export OK=1");
  assert.equal(reports.length, 3);
  assert.equal((reports[2] as HookDiagnostic).outcome, "warning");
  assert.equal(reports[2]!.stderr, "successful stderr\n");
  assert.deepEqual(notices, []);
});

test("successful stderr reporting and quiet failures are independent", async () => {
  for (const quiet of [false, true]) {
    for (const reportStderrOnSuccess of [false, true]) {
      const { cwd, path, hook } = fixture(
        "console.error('warning'); process.stdout.write('export OK=1')",
        2_000,
        quiet,
        reportStderrOnSuccess,
      );
      const reports: HookDiagnostic[] = [];
      const notices: string[] = [];
      const ctx = {
        cwd,
        report: (diagnostic: HookDiagnostic) => reports.push(diagnostic),
        notify: (message: string) => notices.push(message),
      };
      assert.equal(await hook.sourceCode(ctx), "export OK=1");
      assert.equal(reports.length, reportStderrOnSuccess ? 1 : 0);
      if (reportStderrOnSuccess) assert.equal(reports[0]!.outcome, "warning");
      reports.length = 0;
      writeFileSync(path, "console.error('failure'); process.exit(2)");
      assert.equal(await hook.sourceCode(ctx), undefined);
      assert.equal(reports.length, quiet ? 0 : 1);
      assert.equal(notices.length, quiet ? 1 : 0);
      reports.length = 0;
      writeFileSync(path, "process.stdout.write('export OK=1')");
      assert.equal(await hook.sourceCode(ctx), "export OK=1");
      assert.deepEqual(reports, []);
    }
  }
});

test("missing commands and missing working directories can recover on later calls", async () => {
  const { cwd, hook } = fixture("process.stdout.write('export READY=1')");
  const missing = join(cwd, "missing");
  assert.equal(await hook.sourceCode({ cwd: missing }), undefined);
  assert.equal(await hook.sourceCode({ cwd }), "export READY=1");
  const executable = join(cwd, "bin", "node");
  const missingHook = createCommandSourceHook({
    name: "missing",
    command: [executable, "-e", "process.stdout.write('ready')"],
    timeoutMs: 2_000,
  });
  assert.equal(await missingHook.sourceCode({ cwd }), undefined);
  mkdirSync(join(cwd, "bin"));
  symlinkSync(process.execPath, executable);
  assert.equal(await missingHook.sourceCode({ cwd }), "ready");
});

test("hook timeout terminates its process and discards output", async () => {
  const { cwd, hook } = fixture("setInterval(() => {}, 1000)", 100, true);
  const notices: string[] = [];
  assert.equal(
    await hook.sourceCode({ cwd, notify: (message) => notices.push(message) }),
    undefined,
  );
  assert.match(notices[0]!, /timed out after 100ms/);
});

test(
  "cancellation terminates a running hook without emitting a failure notification",
  { timeout: 5_000 },
  async () => {
    const { cwd, hook } = fixture(`
    require('node:fs').writeFileSync('pid', String(process.pid));
    require('node:child_process').spawn(process.execPath, ['-e',
      "require('node:fs').writeFileSync('child-ready', 'ready'); setTimeout(() => require('node:fs').writeFileSync('child-survived', 'yes'), 250);"
    ], { stdio: 'inherit' });
    setInterval(() => {}, 1000);
  `);
    const controller = new AbortController();
    const notices: string[] = [];
    const result = hook.sourceCode({
      cwd,
      signal: controller.signal,
      notify: (message) => notices.push(message),
    });
    while (!existsSync(join(cwd, "child-ready")))
      await new Promise((resolve) => setTimeout(resolve, 10));
    const pid = Number(readFileSync(join(cwd, "pid"), "utf8"));
    controller.abort();
    assert.equal(await result, undefined);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(notices, []);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(existsSync(join(cwd, "child-survived")), false);
  },
);

test("oversized stdout is discarded", async () => {
  const { cwd, hook } = fixture("process.stdout.write('x'.repeat(2 * 1024 * 1024))", 2_000, true);
  const notices: string[] = [];
  assert.equal(
    await hook.sourceCode({ cwd, notify: (message) => notices.push(message) }),
    undefined,
  );
  assert.match(notices[0]!, /stdout exceeds/);
});
