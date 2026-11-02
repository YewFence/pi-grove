import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  defineTool,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolCallEventResult,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createBashJobsExtension, type JobTiming } from "../src/index.ts";

async function createRenderingSession(
  t: TestContext,
  approve: () => Promise<ToolCallEventResult | void>,
  onUpdate?: (component: ToolExecutionComponent) => void,
  timing?: JobTiming,
) {
  initTheme("dark");
  const dir = mkdtempSync(join(tmpdir(), "pi-bash-jobs-render-"));
  const savedXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(dir, "state");
  t.after(() => {
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdg;
  });
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      createBashJobsExtension(timing),
      (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName !== "bash") return undefined;
          return (await approve()) ?? undefined;
        });
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: join(dir, "agent"),
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory(),
  });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  const definition = {
    ...defineTool(createBashToolDefinition(dir)),
    ...session.getToolDefinition("bash"),
  };
  const components = new Map<string, ToolExecutionComponent>();
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const component = new ToolExecutionComponent(
        event.toolName,
        event.toolCallId,
        event.args,
        { showImages: false },
        event.toolName === "bash" ? definition : session.getToolDefinition(event.toolName),
        { requestRender() {} } as TUI,
        dir,
      );
      components.set(event.toolCallId, component);
      component.markExecutionStarted();
    } else if (event.type === "tool_execution_update") {
      const component = components.get(event.toolCallId)!;
      component.updateResult({ ...event.partialResult, isError: false }, true);
      onUpdate?.(component);
    } else if (event.type === "tool_execution_end") {
      components.get(event.toolCallId)!.updateResult({ ...event.result, isError: event.isError });
    }
  });
  return { session, faux, components };
}

const render = (component: ToolExecutionComponent) =>
  stripVTControlCharacters(component.render(120).join("\n"));

test("bash duration excludes approval waiting even when the command produces no output", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  let firstUpdate = true;
  let running = "";
  const { session, faux, components } = await createRenderingSession(
    t,
    async () => {
      await Promise.resolve();
      now += 10_000;
    },
    (component) => {
      if (!firstUpdate) return;
      firstUpdate = false;
      now += 1_200;
      component.invalidate();
      running = render(component);
    },
  );
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("go");
  assert.equal(firstUpdate, false);
  assert.match(running, /Elapsed 1\.2s/);
  const component = [...components.values()][0];
  const completed = render(component);
  assert.match(completed, /\(no output\)/);
  assert.match(completed, /Took 1\.2s/);
  now += 5_000;
  component.invalidate();
  assert.equal(render(component), completed);
});

test("denied bash calls do not display an execution duration", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const { session, faux, components } = await createRenderingSession(t, async () => {
    await Promise.resolve();
    now += 10_000;
    return { block: true, reason: "Approval denied" };
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo never" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("go");
  const completed = render([...components.values()][0]);
  assert.match(completed, /Approval denied/);
  assert.doesNotMatch(completed, /Elapsed|Took/);
});

test("failed and subsequent bash calls retain builtin output rendering and independent durations", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const started = new Set<ToolExecutionComponent>();
  const { session, faux, components } = await createRenderingSession(
    t,
    async () => {
      await Promise.resolve();
      now += 10_000;
    },
    (component) => {
      if (started.has(component)) return;
      started.add(component);
      now += 1_200;
    },
  );
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo bad; exit 3" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo next", timeout: 2 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("go");
  const completed = [...components.values()].map(render);
  assert.match(
    completed[0],
    /\$ echo bad; exit 3[\s\S]*bad[\s\S]*Command exited with code 3[\s\S]*Took 1\.2s/,
  );
  assert.match(completed[1], /\$ echo next \(timeout 2s\)[\s\S]*next[\s\S]*Took 1\.2s/);
  const results = session.messages.filter((message) => message.role === "toolResult");
  assert.deepEqual(
    results.map((message) => message.isError),
    [true, false],
  );
});

test("backgrounding freezes the foreground duration and preserves the job result", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  let firstUpdate = true;
  const { session, faux, components } = await createRenderingSession(
    t,
    async () => {
      await Promise.resolve();
      now += 10_000;
    },
    () => {
      if (!firstUpdate) return;
      firstUpdate = false;
      now += 1_200;
    },
    { yieldIdleMs: 20, yieldMaxMs: 2_000, waitFloorMs: 200, waitMaxMs: 5_000 },
  );
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.1; echo late" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("bash_wait", { job_id: 1, seconds: 5 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  // The job is adopted on the idle yield and already exited before bash_wait runs, so no waiting happens.
  await session.prompt("go");
  const component = [...components.values()][0];
  const completed = render(component);
  assert.match(completed, /still running in the background as job_id 1[\s\S]*Took 1\.2s/);
  const outputComponent = [...components.values()][1];
  const outputRendered = render(outputComponent);
  assert.match(outputRendered, /wait job 1 \(wait 5s\) sleep 0\.1; echo late/);
  assert.match(outputRendered, /late[\s\S]*exited with code 0 \(waited 0s\)/);
  const results = session.messages.filter((message) => message.role === "toolResult");
  assert.deepEqual(results[0].details, { jobId: 1 });
  assert.deepEqual(results[1].details, { jobId: 1, waitedMs: 0 });
  outputComponent.invalidate();
  assert.match(render(outputComponent), /exited with code 0 \(waited 0s\)/);
  assert.match(
    results[1].content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    /late[\s\S]*exited with code 0/,
  );
  now += 5_000;
  component.invalidate();
  assert.equal(render(component), completed);
});
