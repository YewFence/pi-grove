import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  isToolCallEventType,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createBashJobsExtension } from "../src/index.ts";

test("override runs inside a real session and other extensions' bash hooks still apply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bash-jobs-"));
  process.env.XDG_STATE_HOME = join(dir, "state");
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const hookedInputs: string[] = [];
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      createBashJobsExtension({
        yieldIdleMs: 300,
        yieldMaxMs: 2_000,
        waitFloorMs: 200,
        waitMaxMs: 5_000,
      }),
      (pi) => {
        pi.on("tool_call", (event) => {
          if (!isToolCallEventType("bash", event)) return;
          hookedInputs.push(event.input.command);
          event.input.command = `echo hooked; ${event.input.command}`;
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
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1; echo late" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("bash_wait", { job_id: 1, seconds: 5 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  try {
    assert.ok(session.getActiveToolNames().includes("bash_wait"));
    assert.ok(session.getActiveToolNames().includes("bash_kill"));
    await session.prompt("go");
    const results = session.messages.filter((message) => message.role === "toolResult");
    const texts = results.map((message) =>
      message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    );
    assert.deepEqual(hookedInputs, ["sleep 1; echo late"]);
    assert.match(texts[0] ?? "", /^hooked\n[\s\S]*still running in the background as job_id 1/);
    assert.match(texts[1] ?? "", /^late\n[\s\S]*exited with code 0/);
  } finally {
    session.dispose();
  }
});
