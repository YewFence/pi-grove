import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OtlpExporter, type ExporterOptions } from "../src/otlp.js";
import type { OtlpSpan } from "../src/spans.js";

const instantSleep = () => Promise.resolve();

function makeSpan(id: string): OtlpSpan {
  return {
    traceId: "a".repeat(32),
    spanId: id.padEnd(16, "0"),
    name: "pi.segment",
    kind: 1,
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "2000000000",
    attributes: [{ key: "coding.segment.kind", value: { stringValue: "app" } }],
  };
}

function makeExporter(
  dir: string,
  overrides: Partial<ExporterOptions> & { fetchBehavior?: () => Promise<Response> } = {},
) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const { fetchBehavior, ...rest } = overrides;
  const exporter = new OtlpExporter({
    endpoint: "http://tempo.test/v1/traces",
    headers: { authorization: "Basic test" },
    resourceAttributes: [{ key: "service.name", value: { stringValue: "pi-usage" } }],
    scopeVersion: "0.0.0-test",
    stateFile: join(dir, "pending-spans.json"),
    sleep: instantSleep,
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        body: String(init?.body),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return fetchBehavior ? fetchBehavior() : new Response(null, { status: 200 });
    },
    ...rest,
  });
  return { exporter, calls };
}

function postedSpans(calls: { body: string }[]): OtlpSpan[] {
  return calls.flatMap((call) => {
    const payload = JSON.parse(call.body) as {
      resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[];
    };
    return payload.resourceSpans[0]!.scopeSpans[0]!.spans;
  });
}

describe("OtlpExporter", () => {
  it("posts spans as OTLP/HTTP JSON with resource attributes and headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-otlp-"));
    const { exporter, calls } = makeExporter(dir);
    exporter.enqueue(makeSpan("1"));
    await exporter.flush(1000);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://tempo.test/v1/traces");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.headers["authorization"]).toBe("Basic test");
    const payload = JSON.parse(calls[0]!.body);
    expect(payload.resourceSpans[0].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "pi-usage" } },
    ]);
    expect(payload.resourceSpans[0].scopeSpans[0].scope.name).toBe("pi-usage");
    expect(postedSpans(calls).map((span) => span.spanId)).toEqual(["1".padEnd(16, "0")]);
    expect(exporter.stats().sent).toBe(1);
  });

  it("retries failed sends until the backend recovers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-otlp-"));
    let attempts = 0;
    const { exporter } = makeExporter(dir, {
      fetchBehavior: async () => {
        attempts += 1;
        return new Response(null, { status: attempts <= 2 ? 500 : 200 });
      },
    });
    exporter.enqueue(makeSpan("1"));
    await exporter.flush(1000);

    expect(attempts).toBe(3);
    expect(exporter.stats().sent).toBe(1);
    expect(exporter.stats().queued).toBe(0);
  });

  it("never double-sends when flush overlaps the background drain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-otlp-"));
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const { exporter, calls } = makeExporter(dir, {
      fetchBehavior: () => gate.then(() => new Response(null, { status: 200 })),
    });
    exporter.enqueue(makeSpan("1"));
    const flushing = exporter.flush(1000); // overlaps the in-flight background post
    release();
    await flushing;
    await exporter.close();

    expect(postedSpans(calls)).toHaveLength(1);
    expect(exporter.stats().sent).toBe(1);
  });

  it("persists the unsent queue and restores it after a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-otlp-"));
    const stateFile = join(dir, "pending-spans.json");
    const crashing = makeExporter(dir, {
      stateFile,
      fetchBehavior: async () => new Response(null, { status: 503 }),
    });
    crashing.exporter.enqueue(makeSpan("1"));
    crashing.exporter.enqueue(makeSpan("2"));
    await crashing.exporter.close();

    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as OtlpSpan[];
    expect(persisted).toHaveLength(2);

    const recovered = makeExporter(dir, { stateFile });
    await recovered.exporter.load();
    expect(recovered.exporter.stats().queued).toBe(2);
    await recovered.exporter.flush(1000);
    expect(postedSpans(recovered.calls)).toHaveLength(2);
    expect(recovered.exporter.stats().queued).toBe(0);
  });

  it("starts empty on a corrupt state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-otlp-"));
    const stateFile = join(dir, "pending-spans.json");
    writeFileSync(stateFile, "not json{");
    const { exporter } = makeExporter(dir, { stateFile });
    await exporter.load();
    expect(exporter.stats().queued).toBe(0);
  });

  it("drops the oldest spans when the queue overflows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-otlp-"));
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const { exporter, calls } = makeExporter(dir, {
      maxQueue: 2,
      fetchBehavior: () => gate.then(() => new Response(null, { status: 200 })),
    });
    exporter.enqueue(makeSpan("1")); // in flight behind the gate
    exporter.enqueue(makeSpan("2"));
    exporter.enqueue(makeSpan("3"));
    exporter.enqueue(makeSpan("4")); // evicts 2, the oldest unattempted span
    expect(exporter.stats().dropped).toBe(1);
    release();
    await exporter.flush(1000);
    await exporter.close();

    expect(exporter.stats().sent).toBe(3);
    expect(postedSpans(calls).map((span) => span.spanId)).toEqual([
      "1".padEnd(16, "0"),
      "3".padEnd(16, "0"),
      "4".padEnd(16, "0"),
    ]);
  });

  it("flush honors its deadline and keeps leftovers for the next session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-otlp-"));
    const stateFile = join(dir, "pending-spans.json");
    const { exporter } = makeExporter(dir, {
      stateFile,
      fetchBehavior: async () => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        return new Response(null, { status: 500 });
      },
    });
    exporter.enqueue(makeSpan("1"));
    const started = Date.now();
    await exporter.flush(300);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(exporter.stats().queued).toBe(1);
    await exporter.close();
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as OtlpSpan[];
    expect(persisted).toHaveLength(1);
  });
});
