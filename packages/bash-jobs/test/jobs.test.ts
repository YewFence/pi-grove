import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { stringify } from "smol-toml";
import { FIRST_HOOK_ERROR_NOTICE, FIRST_HOOK_WARNING_NOTICE } from "../src/envelope.ts";
import { type BashJobsOptions, createBashJobsExtension, programName } from "../src/index.ts";
import { isolateTestEnvironment } from "./helpers/environment.ts";

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: { jobId?: number } };
type Tool = { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };

function load(t: TestContext, options: BashJobsOptions = {}) {
  const { cwd, agentDir, stateHome } = isolateTestEnvironment(t);
  const eventsPath = join(stateHome, "pi-bash-jobs", "events.jsonl");
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerShortcut: () => {},
    on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  createBashJobsExtension({
    yieldIdleMs: 300,
    yieldMaxMs: 2_000,
    waitFloorMs: 200,
    waitMaxMs: 5_000,
    ...options,
  })(pi);
  const shutdown = () => handlers.get("session_shutdown")?.();
  t.after(shutdown);
  const notifications: Array<{ message: string; type: string }> = [];
  const ctx = {
    cwd,
    model: { id: "test-model" },
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
    ui: {
      notify: (message: string, type: string) => notifications.push({ message, type }),
    },
  };
  const call = (name: string, params: object, signal?: AbortSignal) =>
    tools.get(name)!.execute("call", params, signal, undefined, ctx);
  return {
    call,
    tools,
    eventsPath,
    notifications,
    cwd,
    agentDir,
    start: () => handlers.get("session_start")?.({}, ctx),
    shutdown,
  };
}

const text = (result: ToolResult) => result.content.map((item) => item.text ?? "").join("");

function events(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Event writes are buffered asynchronously; poll until the expected events land on disk. */
async function waitForEvents(
  path: string,
  predicate: (evts: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 3_000;
  let evts = events(path);
  while (!predicate(evts) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    evts = events(path);
  }
  return evts;
}

test("registers bash, bash_wait and bash_kill", (t) => {
  assert.deepEqual([...load(t).tools.keys()], ["bash", "bash_wait", "bash_kill"]);
});

test("bash reads settings from its isolated agent directory", async (t) => {
  const { call, agentDir } = load(t);
  assert.equal(getAgentDir(), agentDir);
  writeFileSync(
    join(getAgentDir(), "settings.json"),
    JSON.stringify({ shellCommandPrefix: "export PI_BASH_JOBS_TEST_SETTINGS=isolated" }),
  );
  const result = await call("bash", {
    command: 'printf "%s" "$PI_BASH_JOBS_TEST_SETTINGS"',
  });
  assert.equal(text(result), "isolated");
});

test("fast command returns like builtin bash", async (t) => {
  const { call } = load(t);
  const result = await call("bash", { command: "echo hi" });
  assert.equal(text(result), "hi\n");
  assert.equal(result.details?.jobId, undefined);
});

test(
  "cancelling while a source hook is pending aborts without starting a command or job",
  { timeout: 2_000 },
  async (t) => {
    let resolvePending!: (value: string) => void;
    let resolveStarted!: () => void;
    const pending = new Promise<string>((resolve) => {
      resolvePending = resolve;
    });
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const marker = join(mkdtempSync(join(tmpdir(), "pi-bash-jobs-abort-")), "executed");
    let laterHookCalls = 0;
    const { call, eventsPath, shutdown } = load(t, {
      yieldIdleMs: 50,
      sourceHooks: [
        {
          name: "pending",
          sourceCode: () => {
            resolveStarted();
            return pending;
          },
        },
        {
          name: "later",
          sourceCode: () => {
            laterHookCalls++;
            return undefined;
          },
        },
      ],
    });
    const controller = new AbortController();
    const result = call("bash", { command: `touch '${marker}'` }, controller.signal);
    try {
      await started;
      controller.abort();
      await assert.rejects(result, /Command aborted/);
      const evts = await waitForEvents(eventsPath, (list) =>
        list.some((event) => event.event === "bash"),
      );
      assert.equal(evts.find((event) => event.event === "bash")?.errorKind, "aborted");
      await assert.rejects(call("bash_wait", { job_id: 1 }), /Unknown job_id/);
    } finally {
      resolvePending("export REVIEW_HOOK=1");
      await new Promise((resolve) => setTimeout(resolve, 75));
      shutdown();
    }
    assert.equal(existsSync(marker), false);
    assert.equal(laterHookCalls, 0);
  },
);

test("source hooks receive notifications and update the command environment in order", async (t) => {
  const {
    call,
    notifications,
    shutdown,
    cwd: expectedCwd,
  } = load(t, {
    sourceHooks: [
      {
        name: "first",
        sourceCode: ({ cwd, notify }) => {
          assert.equal(cwd, expectedCwd);
          notify?.("custom hook warning", "warning");
          return "export PI_GROVE_HOOK_VALUE=first";
        },
      },
      { name: "skipped", sourceCode: () => undefined },
      { name: "last", sourceCode: async () => "export PI_GROVE_HOOK_VALUE=last" },
    ],
  });
  try {
    const result = await call("bash", { command: 'printf "%s" "$PI_GROVE_HOOK_VALUE"' });
    assert.equal(text(result), "last");
    assert.deepEqual(notifications, [{ message: "custom hook warning", type: "warning" }]);
  } finally {
    shutdown();
  }
});

test("configured commands refresh every bash call and config reloads at session start", async (t) => {
  const { call, agentDir, cwd, start, notifications } = load(t);
  const directory = join(agentDir, "extensions", "pi-bash-jobs");
  mkdirSync(directory, { recursive: true });
  const script = join(cwd, "environment.cjs");
  writeFileSync(script, "process.stdout.write('export CONFIG_VALUE=first')");
  const config = join(directory, "config.toml");
  const writeConfig = (command: string[]) =>
    writeFileSync(
      config,
      stringify({
        version: 1,
        source_hooks: [{ name: "configured", command }],
      }),
    );
  writeConfig([process.execPath, script]);
  start();
  const command = 'printf "%s" "$CONFIG_VALUE"';
  assert.equal(text(await call("bash", { command })), "first");
  writeFileSync(script, "process.stdout.write('export CONFIG_VALUE=updated')");
  assert.equal(text(await call("bash", { command })), "updated");
  writeConfig([process.execPath, "-e", "process.stdout.write('export CONFIG_VALUE=reloaded')"]);
  assert.equal(text(await call("bash", { command })), "updated");
  start();
  assert.equal(text(await call("bash", { command })), "reloaded");
  writeFileSync(config, "version = [");
  start();
  const configError = text(await call("bash", { command: "echo still-runs" }));
  assert.match(configError, /<pi-bash-jobs action="config"/);
  assert.match(configError, /config.toml/);
  assert.ok(configError.endsWith("still-runs\n"));
  assert.equal(text(await call("bash", { command: "echo next" })), "next\n");
  assert.match(notifications[0]!.message, /config.toml/);
});

test("configured hook failure skips partial output and still runs bash", async (t) => {
  const { call, agentDir, notifications } = load(t);
  const directory = join(agentDir, "extensions", "pi-bash-jobs");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "config.toml"),
    stringify({
      version: 1,
      source_hooks: [
        {
          name: "broken",
          command: [process.execPath, "-e", "process.stdout.write('exit 9'); process.exit(1)"],
        },
      ],
    }),
  );
  const first = await call("bash", { command: "echo survived" });
  assert.ok(text(first).includes(FIRST_HOOK_ERROR_NOTICE));
  assert.match(text(first), /<pi-bash-jobs action="source-hook" hook="broken" outcome="failed">/);
  assert.ok(text(first).endsWith("survived\n"));
  assert.doesNotMatch(text(first), /exit 9/);
  assert.deepEqual(notifications, []);
  const next = text(await call("bash", { command: "echo next" }));
  assert.match(next, /exited with code 1/);
  assert.equal(next.includes(FIRST_HOOK_ERROR_NOTICE), false);
});

test("quiet failures preserve notifications and the first visible error explains itself", async (t) => {
  const { call, agentDir, notifications, start, cwd } = load(t);
  const directory = join(agentDir, "extensions", "pi-bash-jobs");
  mkdirSync(directory, { recursive: true });
  const config = join(directory, "config.toml");
  const script = join(cwd, "visible.cjs");
  writeFileSync(script, "console.error('successful stderr')");
  writeFileSync(
    config,
    stringify({
      version: 1,
      source_hooks: [
        {
          name: "quiet",
          command: [process.execPath, "-e", "console.error('hidden'); process.exit(1)"],
          quiet: true,
        },
        { name: "visible", command: [process.execPath, script], report_stderr_on_success: false },
      ],
    }),
  );
  assert.equal(text(await call("bash", { command: "echo quiet" })), "quiet\n");
  assert.equal(text(await call("bash", { command: "echo quiet" })), "quiet\n");
  assert.equal(notifications.length, 1);
  writeFileSync(script, "console.error('visible stderr'); process.exit(2)");
  const visible = text(await call("bash", { command: "echo ready" }));
  assert.ok(visible.includes(FIRST_HOOK_ERROR_NOTICE));
  assert.match(visible, /visible stderr/);
  assert.doesNotMatch(visible, /hook="quiet"/);
  assert.equal(
    text(await call("bash", { command: "true" })).includes(FIRST_HOOK_ERROR_NOTICE),
    false,
  );
  start();
  assert.ok(text(await call("bash", { command: "true" })).includes(FIRST_HOOK_ERROR_NOTICE));
});

test("successful stderr warnings preserve initialization and do not consume the first failure explanation", async (t) => {
  const { call, agentDir, cwd, notifications } = load(t);
  const directory = join(agentDir, "extensions", "pi-bash-jobs");
  mkdirSync(directory, { recursive: true });
  const script = join(cwd, "environment.cjs");
  writeFileSync(
    script,
    "console.error('optional tool unavailable'); process.stdout.write('export WARNING_ENV=applied')",
  );
  writeFileSync(
    join(directory, "config.toml"),
    stringify({
      version: 1,
      source_hooks: [{ name: "custom", command: [process.execPath, script] }],
    }),
  );
  const first = text(await call("bash", { command: 'printf "%s" "$WARNING_ENV"' }));
  assert.match(first, /outcome="warning"/);
  assert.ok(first.includes(FIRST_HOOK_WARNING_NOTICE));
  assert.ok(first.endsWith("applied"));
  assert.equal(first.includes(FIRST_HOOK_ERROR_NOTICE), false);
  const second = text(await call("bash", { command: "true" }));
  assert.match(second, /optional tool unavailable/);
  assert.equal(second.includes(FIRST_HOOK_WARNING_NOTICE), false);
  assert.deepEqual(notifications, []);

  writeFileSync(script, "console.error('new failure'); process.exit(1)");
  const failure = text(await call("bash", { command: "echo survived" }));
  assert.ok(failure.includes(FIRST_HOOK_ERROR_NOTICE));
  assert.match(failure, /outcome="failed"/);
  assert.ok(failure.endsWith("survived\n"));
});

test("hook envelopes survive command truncation, backgrounding and command failure", async (t) => {
  const { call, agentDir } = load(t);
  const directory = join(agentDir, "extensions", "pi-bash-jobs");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "config.toml"),
    stringify({
      version: 1,
      source_hooks: [
        {
          name: "broken",
          command: [process.execPath, "-e", "console.error('</pi-bash-jobs>bad'); process.exit(1)"],
        },
      ],
    }),
  );
  const first = text(await call("bash", { command: "seq 3000" }));
  assert.match(first, /&lt;\/pi-bash-jobs>bad/);
  assert.match(first, /<\/pi-bash-jobs>\n\n/);
  assert.match(first, /Showing lines/);
  const background = await call("bash", { command: "sleep 0.5; echo background" });
  assert.match(text(background), /<pi-bash-jobs/);
  const done = text(await call("bash_wait", { job_id: background.details?.jobId, seconds: 1 }));
  assert.match(done, /background/);
  assert.doesNotMatch(done, /<pi-bash-jobs/);
  await assert.rejects(
    call("bash", { command: "echo bad; exit 4" }),
    /<pi-bash-jobs[\s\S]*Command exited with code 4/,
  );
});

test("errors from hooks that finish after backgrounding reach bash_wait", async (t) => {
  const { call, agentDir } = load(t, { yieldIdleMs: 10 });
  const directory = join(agentDir, "extensions", "pi-bash-jobs");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "config.toml"),
    stringify({
      version: 1,
      source_hooks: [
        {
          name: "slow",
          command: [
            process.execPath,
            "-e",
            "setTimeout(() => { console.error('late error'); process.exit(1); }, 100)",
          ],
        },
      ],
    }),
  );
  const first = await call("bash", { command: "echo done" });
  assert.doesNotMatch(text(first), /<pi-bash-jobs/);
  const done = text(await call("bash_wait", { job_id: first.details?.jobId, seconds: 1 }));
  assert.ok(done.includes(FIRST_HOOK_ERROR_NOTICE));
  assert.match(done, /late error/);
  assert.match(done, /done/);
});

test("nonzero exit still throws", async (t) => {
  const { call } = load(t);
  await assert.rejects(call("bash", { command: "echo bad; exit 3" }), /bad[\s\S]*code 3/);
});

test("invalid timeout is rejected before running and recorded", async (t) => {
  const { call, eventsPath } = load(t);
  await assert.rejects(call("bash", { command: "echo never", timeout: 0 }), /Invalid timeout/);
  const evts = await waitForEvents(eventsPath, (list) =>
    list.some((event) => event.event === "bash"),
  );
  assert.equal(evts.find((event) => event.event === "bash")?.errorKind, "invalid_params");
});

test("slow command yields a job and bash_wait collects the rest", async (t) => {
  const { call } = load(t);
  const first = await call("bash", { command: "echo start; sleep 1; echo end" });
  const jobId = first.details?.jobId;
  assert.equal(typeof jobId, "number");
  assert.match(text(first), /^start\n[\s\S]*still running in the background as job_id/);
  const done = await call("bash_wait", { job_id: jobId, seconds: 5 });
  assert.match(text(done), /^end\n[\s\S]*exited with code 0/);
  await assert.rejects(call("bash_wait", { job_id: jobId }), /Unknown job/);
});

test("background job failure surfaces through bash_wait", async (t) => {
  const { call } = load(t);
  const first = await call("bash", { command: "sleep 1; echo oops; exit 4" });
  await assert.rejects(
    call("bash_wait", { job_id: first.details?.jobId, seconds: 5 }),
    /oops[\s\S]*code 4/,
  );
});

test("timeout backgrounds a chatty command instead of killing it", async (t) => {
  const { call } = load(t);
  // Output every 100ms keeps the idle timer from firing, so only the timeout can yield.
  const first = await call("bash", {
    command: "for i in $(seq 12); do echo $i; sleep 0.1; done",
    timeout: 0.5,
  });
  assert.match(text(first), /still running/);
  const done = await call("bash_wait", { job_id: first.details?.jobId, seconds: 5 });
  assert.match(text(done), /\b12\n[\s\S]*exited with code 0/);
});

test("explicit timeout is honored in full: silence does not yield early", async (t) => {
  const { call, eventsPath } = load(t);
  // Output once, then silent past the idle window; only the timeout may yield.
  const first = await call("bash", { command: "echo hi; sleep 1; echo late", timeout: 0.8 });
  assert.match(text(first), /^hi\n[\s\S]*still running/);
  const done = await call("bash_wait", { job_id: first.details?.jobId, seconds: 5 });
  assert.match(text(done), /late[\s\S]*exited with code 0/);
  const evts = await waitForEvents(eventsPath, (list) =>
    list.some((event) => event.event === "job_end" && event.jobId === first.details?.jobId),
  );
  const bash = evts.find((event) => event.event === "bash" && event.jobId === first.details?.jobId);
  assert.equal(bash?.yieldReason, "timeout");
  assert.ok(typeof bash?.elapsedMs === "number" && bash.elapsedMs >= 700);
});

test("bash_kill terminates a running job", async (t) => {
  const { call, shutdown } = load(t);
  const first = await call("bash", { command: "sleep 30" });
  const killed = await call("bash_kill", { job_id: first.details?.jobId });
  assert.match(text(killed), /killed/);
  await assert.rejects(call("bash_kill", { job_id: first.details?.jobId }), /Unknown job/);
  shutdown();
});

test("bash_kill on an already-finished job returns its final result", async (t) => {
  const { call } = load(t);
  const first = await call("bash", { command: "sleep 0.5; echo last; exit 5" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  await assert.rejects(call("bash_kill", { job_id: first.details?.jobId }), /last[\s\S]*code 5/);
});

test("events are appended as JSON lines without command arguments", async (t) => {
  const { call, eventsPath } = load(t);
  const first = await call("bash", { command: "SECRET=tok /bin/sh -c 'sleep 0.5' --secret-arg" });
  await call("bash_wait", { job_id: first.details?.jobId, seconds: 5 });
  const evts = await waitForEvents(
    eventsPath,
    (list) =>
      list.some((event) => event.event === "job_end") &&
      list.some((event) => event.event === "bash_wait"),
  );
  const mine = evts.filter((event) => event.jobId === first.details?.jobId);
  const bash = mine.find((event) => event.event === "bash");
  assert.equal(bash?.program, "sh");
  assert.equal(bash?.model, "test-model");
  assert.equal(bash?.outcome, "yielded");
  assert.equal(bash?.yieldReason, "idle");
  assert.equal(bash?.session, "test");
  assert.ok(mine.some((event) => event.event === "job_end" && event.state === "exited"));
  assert.ok(mine.some((event) => event.event === "bash_wait"));
  assert.doesNotMatch(readFileSync(eventsPath, "utf8"), /SECRET|tok|secret-arg/);
});

test("nonzero exits record the exit code classification", async (t) => {
  const { call, eventsPath } = load(t);
  await assert.rejects(call("bash", { command: "exit 3" }));
  const evts = await waitForEvents(eventsPath, (list) =>
    list.some((event) => event.event === "bash"),
  );
  const bash = evts.find((event) => event.event === "bash");
  assert.equal(bash?.outcome, "error");
  assert.equal(bash?.errorKind, "exit_code");
  assert.equal(bash?.exitCode, 3);
});

test("unknown job lookups are recorded", async (t) => {
  const { call, eventsPath } = load(t);
  await assert.rejects(call("bash_wait", { job_id: 999, seconds: 1 }), /Unknown job_id 999/);
  await assert.rejects(call("bash_kill", { job_id: 999 }), /Unknown job_id 999/);
  const evts = await waitForEvents(
    eventsPath,
    (list) =>
      list.some((event) => event.event === "bash_wait" && event.state === "unknown") &&
      list.some((event) => event.event === "bash_kill" && event.state === "unknown"),
  );
  assert.equal(evts.find((event) => event.event === "bash_wait")?.jobId, 999);
  assert.equal(evts.find((event) => event.event === "bash_kill")?.jobId, 999);
});

test("session shutdown records job_end exactly once for running jobs", async (t) => {
  const { call, eventsPath, shutdown } = load(t);
  const first = await call("bash", { command: "sleep 30" });
  const jobId = first.details?.jobId;
  shutdown();
  const ends = events(eventsPath).filter(
    (event) => event.jobId === jobId && event.event === "job_end",
  );
  assert.equal(ends.length, 1);
  assert.equal(ends[0].state, "killed");
  // The settled promise firing after shutdown must not record a second job_end.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = events(eventsPath).filter(
    (event) => event.jobId === jobId && event.event === "job_end",
  );
  assert.equal(after.length, 1);
});

test("programName keeps only the first program", () => {
  assert.equal(programName("FOO=1 BAR=2 ./node_modules/.bin/tsc -p ."), "tsc");
  assert.equal(programName("(cd x && make)"), "cd");
  assert.equal(programName("   "), "");
});
