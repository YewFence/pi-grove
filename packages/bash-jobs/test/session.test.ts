import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "smol-toml";
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
import { FIRST_HOOK_ERROR_NOTICE } from "../src/envelope.ts";
import { createBashJobsExtension } from "../src/index.ts";
import { isolateTestEnvironment } from "./helpers/environment.ts";

test("override runs inside a real session and other extensions' bash hooks still apply", async (t) => {
  const { cwd: dir, agentDir } = isolateTestEnvironment(t);
  const configDir = join(agentDir, "extensions", "pi-bash-jobs");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.toml"),
    stringify({
      version: 1,
      source_hooks: [
        {
          name: "session-env",
          command: [process.execPath, "-e", "process.stdout.write('export SESSION_ENV=late')"],
        },
      ],
    }),
  );
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
    agentDir,
    settingsManager: SettingsManager.inMemory(),
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
    agentDir,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory(),
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: 'sleep 1; echo "$SESSION_ENV"' }), {
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
    assert.deepEqual(hookedInputs, ['sleep 1; echo "$SESSION_ENV"']);
    assert.match(texts[0] ?? "", /^hooked\n[\s\S]*still running in the background as job_id 1/);
    assert.match(texts[1] ?? "", /^late\n[\s\S]*exited with code 0/);
    writeFileSync(
      join(configDir, "config.toml"),
      stringify({
        version: 1,
        source_hooks: [
          {
            name: "broken",
            command: [process.execPath, "-e", "console.error('session error'); process.exit(2)"],
          },
        ],
      }),
    );
    await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo first" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo second" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("run again");
    const failures = session.messages.filter((message) => message.role === "toolResult").slice(-2);
    const diagnostics = failures.map((result) =>
      result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    );
    assert.deepEqual(
      failures.map((result) => result.isError),
      [false, false],
    );
    assert.ok(diagnostics[0]!.includes(FIRST_HOOK_ERROR_NOTICE));
    assert.equal(diagnostics[1]!.includes(FIRST_HOOK_ERROR_NOTICE), false);
    for (const diagnostic of diagnostics) {
      assert.match(diagnostic, /<pi-bash-jobs action="source-hook" hook="broken"/);
      assert.match(diagnostic, /session error/);
    }
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});
