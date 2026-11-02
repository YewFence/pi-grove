import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashJobsExtension, programName } from "../src/index.ts";

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: { jobId?: number } };
type Tool = { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };

function load() {
  const stateHome = mkdtempSync(join(tmpdir(), "pi-bash-jobs-state-"));
  const eventsPath = join(stateHome, "pi-bash-jobs", "events.jsonl");
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, () => void>();
  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerShortcut: () => {},
    on: (event: string, handler: () => void) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  const savedXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  createBashJobsExtension({
    yieldIdleMs: 300,
    yieldMaxMs: 2_000,
    waitFloorMs: 200,
    waitMaxMs: 5_000,
  })(pi);
  process.env.XDG_STATE_HOME = savedXdg;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "test-model" },
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
  };
  const call = (name: string, params: object) =>
    tools.get(name)!.execute("call", params, undefined, undefined, ctx);
  return { call, tools, eventsPath, shutdown: () => handlers.get("session_shutdown")?.() };
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

test("registers bash, bash_wait and bash_kill", () => {
  assert.deepEqual([...load().tools.keys()], ["bash", "bash_wait", "bash_kill"]);
});

test("fast command returns like builtin bash", async () => {
  const { call } = load();
  const result = await call("bash", { command: "echo hi" });
  assert.equal(text(result), "hi\n");
  assert.equal(result.details?.jobId, undefined);
});

test("nonzero exit still throws", async () => {
  const { call } = load();
  await assert.rejects(call("bash", { command: "echo bad; exit 3" }), /bad[\s\S]*code 3/);
});

test("invalid timeout is rejected before running and recorded", async () => {
  const { call, eventsPath } = load();
  await assert.rejects(call("bash", { command: "echo never", timeout: 0 }), /Invalid timeout/);
  const evts = await waitForEvents(eventsPath, (list) =>
    list.some((event) => event.event === "bash"),
  );
  assert.equal(evts.find((event) => event.event === "bash")?.errorKind, "invalid_params");
});

test("slow command yields a job and bash_wait collects the rest", async () => {
  const { call } = load();
  const first = await call("bash", { command: "echo start; sleep 1; echo end" });
  const jobId = first.details?.jobId;
  assert.equal(typeof jobId, "number");
  assert.match(text(first), /^start\n[\s\S]*still running in the background as job_id/);
  const done = await call("bash_wait", { job_id: jobId, seconds: 5 });
  assert.match(text(done), /^end\n[\s\S]*exited with code 0/);
  await assert.rejects(call("bash_wait", { job_id: jobId }), /Unknown job/);
});

test("background job failure surfaces through bash_wait", async () => {
  const { call } = load();
  const first = await call("bash", { command: "sleep 1; echo oops; exit 4" });
  await assert.rejects(
    call("bash_wait", { job_id: first.details?.jobId, seconds: 5 }),
    /oops[\s\S]*code 4/,
  );
});

test("timeout backgrounds a chatty command instead of killing it", async () => {
  const { call } = load();
  // Output every 100ms keeps the idle timer from firing, so only the timeout can yield.
  const first = await call("bash", {
    command: "for i in $(seq 12); do echo $i; sleep 0.1; done",
    timeout: 0.5,
  });
  assert.match(text(first), /still running/);
  const done = await call("bash_wait", { job_id: first.details?.jobId, seconds: 5 });
  assert.match(text(done), /\b12\n[\s\S]*exited with code 0/);
});

test("explicit timeout is honored in full: silence does not yield early", async () => {
  const { call, eventsPath } = load();
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

test("bash_kill terminates a running job", async () => {
  const { call, shutdown } = load();
  const first = await call("bash", { command: "sleep 30" });
  const killed = await call("bash_kill", { job_id: first.details?.jobId });
  assert.match(text(killed), /killed/);
  await assert.rejects(call("bash_kill", { job_id: first.details?.jobId }), /Unknown job/);
  shutdown();
});

test("bash_kill on an already-finished job returns its final result", async () => {
  const { call } = load();
  const first = await call("bash", { command: "sleep 0.5; echo last; exit 5" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  await assert.rejects(call("bash_kill", { job_id: first.details?.jobId }), /last[\s\S]*code 5/);
});

test("events are appended as JSON lines without command arguments", async () => {
  const { call, eventsPath } = load();
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

test("nonzero exits record the exit code classification", async () => {
  const { call, eventsPath } = load();
  await assert.rejects(call("bash", { command: "exit 3" }));
  const evts = await waitForEvents(eventsPath, (list) =>
    list.some((event) => event.event === "bash"),
  );
  const bash = evts.find((event) => event.event === "bash");
  assert.equal(bash?.outcome, "error");
  assert.equal(bash?.errorKind, "exit_code");
  assert.equal(bash?.exitCode, 3);
});

test("unknown job lookups are recorded", async () => {
  const { call, eventsPath } = load();
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

test("session shutdown records job_end exactly once for running jobs", async () => {
  const { call, eventsPath, shutdown } = load();
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
