import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

for (const scenario of [
  {
    name: "whitespace candidate diagnostics",
    original: "\t\tvalue: number;\n",
    edits: [{ oldText: "        value: number;", newText: "        value: string;" }],
    expected: [
      /Could not find the exact text\./,
      /A unique candidate differs only in whitespace at lines 1-1/,
      /Your input \(oldText\): .*value: number/,
      /File content:.*\\t\\tvalue: number/,
    ],
  },
  {
    name: "edits[3] diagnostics without a candidate",
    original: "first();\nsecond();\nthird();\n",
    edits: [
      { oldText: "first();", newText: "one();" },
      { oldText: "second();", newText: "two();" },
      { oldText: "third();", newText: "three();" },
      { oldText: "missing();", newText: "four();" },
    ],
    expected: [/Could not find edits\[3\]\./, /No exact or supported fuzzy match was found\./],
  },
]) {
  test(
    `renders ${scenario.name} once inside the call box after the asynchronous preview settles`,
    { timeout: 5000 },
    async (t) => {
      initTheme("dark");
      const dir = mkdtempSync(join(tmpdir(), "pi-edit-diagnostics-"));
      const previousStateHome = process.env.XDG_STATE_HOME;
      process.env.XDG_STATE_HOME = join(dir, "state");
      t.onTestFinished(() => {
        if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previousStateHome;
      });
      const filePath = join(dir, "example.ts");
      writeFileSync(filePath, scenario.original);

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
        additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);

      const { session } = await createAgentSession({
        cwd: dir,
        agentDir: join(dir, "agent"),
        model: faux.getModel(),
        modelRuntime,
        resourceLoader,
        sessionManager: SessionManager.inMemory(dir),
        settingsManager: SettingsManager.inMemory(),
      });
      const components = new Map<string, ToolExecutionComponent>();
      const previews = new Map<string, Promise<void>>();
      session.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          let resolvePreview!: () => void;
          const preview = new Promise<void>((resolve) => {
            resolvePreview = resolve;
          });
          let initializing = true;
          const component = new ToolExecutionComponent(
            event.toolName,
            event.toolCallId,
            event.args,
            { showImages: false },
            session.getToolDefinition(event.toolName),
            {
              requestRender() {
                if (!initializing) resolvePreview();
              },
            } as TUI,
            dir,
          );
          components.set(event.toolCallId, component);
          previews.set(event.toolCallId, preview);
          component.markExecutionStarted();
          component.setArgsComplete();
          initializing = false;
        } else if (event.type === "tool_execution_end") {
          components
            .get(event.toolCallId)!
            .updateResult({ ...event.result, isError: event.isError });
        }
      });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("edit", { path: "example.ts", edits: scenario.edits }), {
          stopReason: "toolUse",
        }),
        (context) => {
          const results = context.messages.filter((message) => message.role === "toolResult");
          assert.equal(results.length, 1);
          assert.equal(results[0]!.isError, true);
          const text = results[0]!.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("");
          for (const pattern of scenario.expected) assert.match(text, pattern);
          assert.equal((text.match(/Could not find/g) ?? []).length, 1);
          assert.doesNotMatch(text, /The old(?: text|Text) must match exactly/);
          return fauxAssistantMessage("done");
        },
      ]);

      try {
        await session.prompt("fix it");
        assert.equal(readFileSync(filePath, "utf8"), scenario.original);
        await Promise.all(previews.values());
        const component = [...components.values()][0]!;
        for (const width of [160, 80, 40]) {
          const lines = component.render(width);
          const rendered = stripVTControlCharacters(lines.join("\n"));
          assert.equal((rendered.match(/Could not find/g) ?? []).length, 1);
          assert.equal((rendered.match(/No changes were written\./g) ?? []).length, 1);
          assert.doesNotMatch(rendered, /The old(?: text|Text) must match exactly/);
          if (width === 160) {
            for (const pattern of scenario.expected) assert.match(rendered, pattern);
          }
          const header = lines.find((line) =>
            stripVTControlCharacters(line).includes("edit example.ts"),
          )!;
          // Tool framing is observable only in the ANSI output.
          // oxlint-disable-next-line eslint/no-control-regex
          const background = header.match(/\u001b\[48;[\d;]+m/u)?.[0];
          assert.ok(background, "the call header must have a background");
          for (const diagnosticLine of lines.filter((line) =>
            stripVTControlCharacters(line).trim(),
          )) {
            assert.ok(
              diagnosticLine.includes(background),
              "every diagnostic line must stay inside the call background",
            );
          }
          component.setExpanded(true);
          component.invalidate();
          assert.equal(stripVTControlCharacters(component.render(width).join("\n")), rendered);
        }
      } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    },
  );
}

test(
  "records five read/edit/write calls after failure and refreshes the window on another failed edit",
  { timeout: 5000 },
  async (t) => {
    initTheme("dark");
    const dir = mkdtempSync(join(tmpdir(), "pi-edit-diagnostics-telemetry-"));
    const stateHome = join(dir, "state");
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    t.onTestFinished(() => {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
    });
    const filePath = join(dir, "example.ts");
    writeFileSync(filePath, "value();\n");

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
      additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
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
    const failedEdit = {
      path: "example.ts",
      edits: [
        {
          oldText: '\tmissing("云枫");\nmissingAgain();',
          newText: '\tfixed("云枫");\nfixedAgain();',
        },
      ],
    };
    const read = { path: "example.ts", offset: 1, limit: 20 };
    const write = { path: "example.ts", content: '\tfixed("云枫");\n' };
    const successfulEdit = {
      path: "example.ts",
      edits: [{ oldText: '\tfixed("云枫");', newText: '\tdone("云枫");' }],
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", read), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("edit", failedEdit), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", read), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", read), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("edit", failedEdit), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", read), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", read), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write", write), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("edit", successfulEdit), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", read), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", read), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);

    try {
      await session.prompt("fix it");
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      const eventsPath = join(stateHome, "pi-edit-diagnostics", "events.jsonl");
      const raw = readFileSync(eventsPath, "utf8");
      const events: Array<Record<string, unknown>> = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        events.map(({ phase, toolName, isError, step }) => ({ phase, toolName, isError, step })),
        [
          { phase: "edit_result", toolName: "edit", isError: true, step: undefined },
          { phase: "follow_up_result", toolName: "read", isError: false, step: 1 },
          { phase: "follow_up_result", toolName: "read", isError: false, step: 2 },
          { phase: "follow_up_result", toolName: "edit", isError: true, step: 3 },
          { phase: "follow_up_result", toolName: "read", isError: false, step: 1 },
          { phase: "follow_up_result", toolName: "read", isError: false, step: 2 },
          { phase: "follow_up_result", toolName: "write", isError: false, step: 3 },
          { phase: "follow_up_result", toolName: "edit", isError: false, step: 4 },
          { phase: "follow_up_result", toolName: "read", isError: false, step: 5 },
        ],
      );
      assert.equal(events[0]!.diagnostic, true);
      assert.equal(events[3]!.diagnostic, true);
      for (const event of events.slice(1, 4))
        assert.equal(event.triggerCallId, events[0]!.toolCallId);
      for (const event of events.slice(4)) assert.equal(event.triggerCallId, events[3]!.toolCallId);
      assert.equal(new Set(events.map((event) => event.toolCallId)).size, events.length);
      assert.ok(
        events.every(
          (event) =>
            event.session === session.sessionManager.getSessionId() &&
            event.model === faux.getModel().id,
        ),
      );
      assert.equal(readFileSync(filePath, "utf8"), '\tdone("云枫");\n');
      assert.deepEqual(
        events.map((event) => event.input),
        [failedEdit, read, read, failedEdit, read, read, write, successfulEdit, read],
      );
    } finally {
      session.dispose();
    }
  },
);
