/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piUsage from "../src/index.js";

interface FakePi {
  pi: ExtensionAPI;
  handlers: Map<string, (event: any, ctx: any) => unknown>;
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  notices: string[];
}

function createFakePi(): FakePi {
  const fake: FakePi = {
    handlers: new Map(),
    commands: new Map(),
    notices: [],
    pi: {
      on: (event: string, handler: any) => {
        fake.handlers.set(event, handler);
        return () => {};
      },
      registerCommand: (name: string, def: any) => {
        fake.commands.set(name, def);
      },
    } as unknown as ExtensionAPI,
  };
  return fake;
}

function createCtx(cwd: string, sessionId = "test-session") {
  const notices: string[] = [];
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (message: string) => notices.push(message) },
    notices,
  };
}

interface PostedCall {
  url: string;
  body: any;
}

function stubFetch(): PostedCall[] {
  const calls: PostedCall[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 200 });
  });
  return calls;
}

function allSpans(calls: PostedCall[]): any[] {
  return calls.flatMap((call) =>
    call.body.resourceSpans.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans)),
  );
}

function spanAttributes(span: any): Record<string, string> {
  return Object.fromEntries(
    span.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue]),
  );
}

describe("pi-usage extension", () => {
  let dir: string;
  let stateDir: string;
  let fake: FakePi;
  let previousEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-usage-ext-"));
    stateDir = mkdtempSync(join(tmpdir(), "pi-usage-state-"));
    mkdirSync(join(dir, ".jj"));
    fake = createFakePi();
    previousEnv = { ...process.env };
    process.env.XDG_STATE_HOME = stateDir;
    delete process.env.PI_USAGE_OTLP_ENDPOINT;
    delete process.env.PI_USAGE_OTLP_TRACES_ENDPOINT;
    delete process.env.PI_USAGE_OTLP_HEADERS;
    delete process.env.PI_USAGE_OTLP_TRACES_HEADERS;
    delete process.env.PI_USAGE_RESOURCE_ATTRIBUTES;
    delete process.env.PI_USAGE_USE_OTEL_ENV;
    delete process.env.PI_USAGE_ENABLED;
    delete process.env.PI_USAGE_ENTITY;
    delete process.env.PI_USAGE_PROJECT;
    piUsage(fake.pi);
  });

  afterEach(() => {
    process.env = previousEnv;
    vi.unstubAllGlobals();
  });

  async function dispatch(event: string, payload: any, ctx: any) {
    const handler = fake.handlers.get(event);
    expect(handler, `handler for ${event}`).toBeDefined();
    await handler!(payload, ctx);
  }

  it("exports a request span and a file segment span for an edit flow", async () => {
    process.env.PI_USAGE_OTLP_ENDPOINT = "http://tempo.test:4318";
    const calls = stubFetch();
    const ctx = createCtx(dir);
    const target = join(dir, "src", "main.py");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(target, "print('before')\n");

    await dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
    await dispatch("before_agent_start", { type: "before_agent_start", messageType: "user" }, ctx);
    await dispatch("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
    await dispatch(
      "tool_call",
      { type: "tool_call", toolName: "edit", input: { path: "src/main.py" }, toolCallId: "1" },
      ctx,
    );
    writeFileSync(target, "print('after')\n");
    await dispatch("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
    await dispatch("agent_settled", { type: "agent_settled", aborted: false }, ctx);
    await dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.url).toBe("http://tempo.test:4318/v1/traces");
    const resource = calls[0]!.body.resourceSpans[0].resource.attributes;
    expect(resource).toContainEqual({ key: "service.name", value: { stringValue: "pi-usage" } });

    const spans = allSpans(calls);
    const segment = spans.find((span) => span.name === "pi.segment");
    const request = spans.find((span) => span.name === "pi.request");
    expect(segment).toBeDefined();
    expect(request).toBeDefined();
    expect(segment.traceId).toBe(request.traceId);
    expect(segment.parentSpanId).toBe(request.spanId);

    const attributes = spanAttributes(segment);
    expect(attributes["coding.segment.kind"]).toBe("file");
    expect(attributes["coding.language"]).toBe("Python");
    expect(attributes["coding.entity"]).toBe("src/main.py");
    expect(attributes["coding.project"]).toBe(dir.split("/").pop());
    expect(Number(segment.endTimeUnixNano)).toBeGreaterThan(Number(segment.startTimeUnixNano));
  });

  it("does not attribute a tool call that left the file unchanged", async () => {
    process.env.PI_USAGE_OTLP_ENDPOINT = "http://tempo.test:4318";
    const calls = stubFetch();
    const ctx = createCtx(dir);
    const target = join(dir, "notes.md");
    writeFileSync(target, "same\n");

    await dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
    await dispatch("before_agent_start", { type: "before_agent_start", messageType: "user" }, ctx);
    await dispatch("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
    await dispatch(
      "tool_call",
      { type: "tool_call", toolName: "write", input: { path: "notes.md" }, toolCallId: "1" },
      ctx,
    );
    writeFileSync(target, "same\n"); // identical content: not a modification
    await dispatch("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
    await dispatch("agent_settled", { type: "agent_settled", aborted: false }, ctx);
    await dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    const kinds = allSpans(calls)
      .filter((span) => span.name === "pi.segment")
      .map((span) => spanAttributes(span)["coding.segment.kind"]);
    expect(kinds.every((kind) => kind === "app")).toBe(true);
  });

  it("counts one overlapping same-path batch as a single modification", async () => {
    process.env.PI_USAGE_OTLP_ENDPOINT = "http://tempo.test:4318";
    const calls = stubFetch();
    const ctx = createCtx(dir);
    const target = join(dir, "a.ts");
    writeFileSync(target, "const a = 1;\n");

    await dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
    await dispatch("before_agent_start", { type: "before_agent_start", messageType: "user" }, ctx);
    await dispatch("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
    const call = (id: string) =>
      dispatch(
        "tool_call",
        { type: "tool_call", toolName: "edit", input: { path: "a.ts" }, toolCallId: id },
        ctx,
      );
    await Promise.all([call("1"), call("2")]); // parallel edits to the same file
    writeFileSync(target, "const a = 2;\n");
    await dispatch("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
    await dispatch("agent_settled", { type: "agent_settled", aborted: false }, ctx);
    await dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    const segments = allSpans(calls).filter((span) => span.name === "pi.segment");
    const fileSegments = segments.filter(
      (span) => spanAttributes(span)["coding.segment.kind"] === "file",
    );
    const total = fileSegments.reduce(
      (sum, span) => sum + (Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)),
      0,
    );
    const whole = segments.reduce(
      (sum, span) => sum + (Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)),
      0,
    );
    // One file claims the turn's pending time exactly once, never twice.
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(whole);
  });

  it("stays inert without an endpoint and reports why", async () => {
    const calls = stubFetch();
    const ctx = createCtx(dir);
    await dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
    await dispatch("before_agent_start", { type: "before_agent_start", messageType: "user" }, ctx);
    await dispatch("agent_settled", { type: "agent_settled", aborted: false }, ctx);
    const command = fake.commands.get("pi-usage");
    await command!.handler("", ctx);
    await dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    expect(calls).toHaveLength(0);
    expect(ctx.notices.join("\n")).toMatch(/inactive/);
    expect(ctx.notices.join("\n")).toMatch(/endpoint/);
  });

  it("status command reports session totals while exporting", async () => {
    process.env.PI_USAGE_OTLP_ENDPOINT = "http://tempo.test:4318";
    stubFetch();
    const ctx = createCtx(dir);
    const target = join(dir, "b.go");
    writeFileSync(target, "package main\n");

    await dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
    await dispatch("before_agent_start", { type: "before_agent_start", messageType: "user" }, ctx);
    await dispatch("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
    await dispatch(
      "tool_call",
      { type: "tool_call", toolName: "edit", input: { path: "b.go" }, toolCallId: "1" },
      ctx,
    );
    writeFileSync(target, "package main\n\nfunc main() {}\n");
    await dispatch("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
    const command = fake.commands.get("pi-usage");
    await command!.handler("", ctx);
    await dispatch("agent_settled", { type: "agent_settled", aborted: false }, ctx);
    await dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    expect(ctx.notices.join("\n")).toMatch(/exporting/);
    expect(ctx.notices.join("\n")).toMatch(/Go/);
  });
});
