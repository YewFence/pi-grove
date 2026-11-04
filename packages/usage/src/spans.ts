import { createHash, randomBytes } from "node:crypto";
import { relative } from "node:path";

import { languageForPath } from "./language.js";
import type { SpanRecord } from "./ledger.js";

export interface OtlpAttribute {
  key: string;
  value: { stringValue: string };
}

/** The subset of the OTLP/HTTP JSON span model this extension emits. */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** SPAN_KIND_INTERNAL */
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
}

export interface SpanSettings {
  projectRoot: string;
  projectName: string;
  entityMode: "path" | "off";
}

export function attr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/** Deterministic trace id per session, so one pi session reads as one trace. */
export function traceIdForSession(sessionId: string): string {
  return createHash("sha256").update(`pi-usage:session:${sessionId}`).digest("hex").slice(0, 32);
}

/** Deterministic parent id per request; segment spans may arrive before the request span. */
export function requestSpanId(traceId: string, requestId: number): string {
  return createHash("sha256")
    .update(`pi-usage:request:${traceId}:${requestId}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Span names stay fixed and low-cardinality; everything variable lives in
 * `coding.*` attributes. Deliberately no `gen_ai.*`: models, tokens, prompts
 * and command text are out of scope by design.
 */
export function buildSpan(record: SpanRecord, settings: SpanSettings, traceId: string): OtlpSpan {
  const attributes: OtlpAttribute[] = [
    attr("coding.request.id", `req-${record.requestId}`),
    attr("coding.project", settings.projectName),
  ];
  let name: string;
  let parentSpanId: string | undefined;
  let spanId: string;
  if (record.role === "request") {
    name = "pi.request";
    spanId = requestSpanId(traceId, record.requestId);
  } else {
    name = "pi.segment";
    spanId = randomBytes(8).toString("hex");
    parentSpanId = requestSpanId(traceId, record.requestId);
    attributes.push(attr("coding.segment.kind", record.kind ?? "app"));
    if (record.kind === "file" && record.file) {
      const language = languageForPath(record.file);
      if (language) attributes.push(attr("coding.language", language));
      if (settings.entityMode === "path") {
        attributes.push(attr("coding.entity", entityPath(record.file, settings.projectRoot)));
      }
    }
  }
  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    kind: 1,
    startTimeUnixNano: msToNano(record.startWall),
    endTimeUnixNano: msToNano(Math.max(record.endWall, record.startWall + 0.001)),
    attributes,
  };
}

function entityPath(absolutePath: string, projectRoot: string): string {
  const rel = relative(projectRoot, absolutePath);
  return rel && !rel.startsWith("..") ? rel : absolutePath;
}

function msToNano(ms: number): string {
  return BigInt(Math.round(ms * 1e6)).toString();
}
