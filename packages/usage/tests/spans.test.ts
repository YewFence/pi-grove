import { describe, expect, it } from "vitest";

import type { SpanRecord } from "../src/ledger.js";
import { buildSpan, requestSpanId, traceIdForSession, type SpanSettings } from "../src/spans.js";

const SETTINGS: SpanSettings = {
  projectRoot: "/repo",
  projectName: "demo",
  entityMode: "path",
};

const record = (overrides: Partial<SpanRecord>): SpanRecord => ({
  requestId: 3,
  role: "segment",
  kind: "file",
  file: "/repo/src/a.py",
  startWall: 1_700_000_000_000,
  endWall: 1_700_000_090_000,
  durationMs: 90_000,
  ...overrides,
});

describe("trace and span ids", () => {
  it("derives a stable 128-bit trace id from the session id", () => {
    const traceId = traceIdForSession("session-1");
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIdForSession("session-1")).toBe(traceId);
    expect(traceIdForSession("session-2")).not.toBe(traceId);
  });

  it("derives a stable request span id per trace and request", () => {
    const id = requestSpanId("t", 1);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(requestSpanId("t", 1)).toBe(id);
    expect(requestSpanId("t", 2)).not.toBe(id);
    expect(requestSpanId("u", 1)).not.toBe(id);
  });
});

describe("buildSpan", () => {
  it("builds a request span without a parent", () => {
    const traceId = traceIdForSession("s");
    const span = buildSpan(
      record({ role: "request", kind: undefined, file: undefined }),
      SETTINGS,
      traceId,
    );
    expect(span.name).toBe("pi.request");
    expect(span.parentSpanId).toBeUndefined();
    expect(span.spanId).toBe(requestSpanId(traceId, 3));
    const keys = span.attributes.map((attribute) => attribute.key);
    expect(keys).toEqual(["coding.request.id", "coding.project"]);
  });

  it("builds a file segment span parented to its request", () => {
    const traceId = traceIdForSession("s");
    const span = buildSpan(record({}), SETTINGS, traceId);
    expect(span.name).toBe("pi.segment");
    expect(span.kind).toBe(1);
    expect(span.parentSpanId).toBe(requestSpanId(traceId, 3));
    const attributes = Object.fromEntries(
      span.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]),
    );
    expect(attributes["coding.segment.kind"]).toBe("file");
    expect(attributes["coding.language"]).toBe("Python");
    expect(attributes["coding.entity"]).toBe("src/a.py");
    expect(attributes["coding.project"]).toBe("demo");
    expect(span.startTimeUnixNano).toBe("1700000000000000000");
    expect(span.endTimeUnixNano).toBe("1700000090000000000");
  });

  it("emits real wall timestamps, not send-time timestamps", () => {
    const span = buildSpan(
      record({ startWall: 1000, endWall: 61_000, durationMs: 60_000 }),
      SETTINGS,
      "t",
    );
    expect(span.startTimeUnixNano).toBe("1000000000");
    expect(span.endTimeUnixNano).toBe("61000000000");
  });

  it("omits language for unknown extensions and app segments", () => {
    const unknown = buildSpan(record({ file: "/repo/data.blob" }), SETTINGS, "t");
    expect(unknown.attributes.some((attribute) => attribute.key === "coding.language")).toBe(false);
    const app = buildSpan(record({ kind: "app", file: undefined }), SETTINGS, "t");
    const keys = app.attributes.map((attribute) => attribute.key);
    expect(keys).toContain("coding.segment.kind");
    expect(keys).not.toContain("coding.language");
    expect(keys).not.toContain("coding.entity");
  });

  it("keeps absolute entity paths outside the project root and honors entity off mode", () => {
    const outside = buildSpan(record({ file: "/etc/hosts" }), SETTINGS, "t");
    const entity = outside.attributes.find((attribute) => attribute.key === "coding.entity");
    expect(entity?.value.stringValue).toBe("/etc/hosts");
    const hidden = buildSpan(record({}), { ...SETTINGS, entityMode: "off" }, "t");
    expect(hidden.attributes.some((attribute) => attribute.key === "coding.entity")).toBe(false);
  });
});
