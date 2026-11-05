import { describe, expect, it } from "vitest";

import { loadConfig, parsePairs } from "../src/config.js";

describe("loadConfig", () => {
  it("stays inert without any endpoint", () => {
    const config = loadConfig({});
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toMatch(/endpoint/);
    expect(config.endpoint).toBeUndefined();
    expect(config.usedOtelFallback).toBe(false);
  });

  it("ignores standard OTEL_* variables unless explicitly opted in", () => {
    const config = loadConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://other-tool:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://other-tool:4318/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Basic other",
      OTEL_RESOURCE_ATTRIBUTES: "service.namespace=other",
    });
    expect(config.enabled).toBe(false);
    expect(config.headers).toEqual({});
    expect(config.resourceAttributes).toEqual({});
  });

  it("appends /v1/traces to the namespaced generic endpoint", () => {
    const config = loadConfig({ PI_USAGE_OTLP_ENDPOINT: "http://tempo:4318/" });
    expect(config.enabled).toBe(true);
    expect(config.endpoint).toBe("http://tempo:4318/v1/traces");
  });

  it("uses the namespaced signal-specific endpoint verbatim", () => {
    const config = loadConfig({
      PI_USAGE_OTLP_ENDPOINT: "http://tempo:4318",
      PI_USAGE_OTLP_TRACES_ENDPOINT: "http://oo:5080/api/default/v1/traces",
    });
    expect(config.endpoint).toBe("http://oo:5080/api/default/v1/traces");
  });

  it("prefers PI_USAGE_* over standard variables when fallback is on", () => {
    const config = loadConfig({
      PI_USAGE_USE_OTEL_ENV: "true",
      PI_USAGE_OTLP_TRACES_ENDPOINT: "http://pi-usage:4318/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://other-tool:4318/v1/traces",
      PI_USAGE_OTLP_HEADERS: "authorization=Basic pi",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Basic other",
      PI_USAGE_RESOURCE_ATTRIBUTES: "service.namespace=pi",
      OTEL_RESOURCE_ATTRIBUTES: "service.namespace=other",
    });
    expect(config.usedOtelFallback).toBe(true);
    expect(config.endpoint).toBe("http://pi-usage:4318/v1/traces");
    expect(config.headers).toEqual({ authorization: "Basic pi" });
    expect(config.resourceAttributes).toEqual({ "service.namespace": "pi" });
  });

  it("falls back to standard variables when opted in", () => {
    const config = loadConfig({
      PI_USAGE_USE_OTEL_ENV: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Basic generic",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Basic specific, x-scope-orgid=42",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod",
    });
    expect(config.enabled).toBe(true);
    expect(config.endpoint).toBe("http://tempo:4318/v1/traces");
    expect(config.headers).toEqual({ authorization: "Basic specific", "x-scope-orgid": "42" });
    expect(config.resourceAttributes).toEqual({ "deployment.environment": "prod" });
  });

  it("prefers namespaced header and attribute lists over the standard ones", () => {
    const config = loadConfig({
      PI_USAGE_USE_OTEL_ENV: "on",
      PI_USAGE_OTLP_HEADERS: "authorization=Basic pi",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Basic other",
      PI_USAGE_RESOURCE_ATTRIBUTES: "service.namespace=pi",
      OTEL_RESOURCE_ATTRIBUTES: "service.namespace=other",
    });
    expect(config.headers).toEqual({ authorization: "Basic pi" });
    expect(config.resourceAttributes).toEqual({ "service.namespace": "pi" });
  });

  it("honors the explicit disable toggle", () => {
    const config = loadConfig({
      PI_USAGE_OTLP_ENDPOINT: "http://tempo:4318",
      PI_USAGE_ENABLED: "0",
    });
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toMatch(/PI_USAGE_ENABLED/);
  });

  it("supports entity off mode and project override", () => {
    const config = loadConfig({
      PI_USAGE_OTLP_ENDPOINT: "http://tempo:4318",
      PI_USAGE_ENTITY: "off",
      PI_USAGE_PROJECT: "dotfiles",
    });
    expect(config.entityMode).toBe("off");
    expect(config.projectOverride).toBe("dotfiles");
  });

  it("places the default state file under XDG_STATE_HOME", () => {
    const config = loadConfig({ XDG_STATE_HOME: "/tmp/state" });
    expect(config.stateFile).toBe("/tmp/state/pi-usage/pending-spans.json");
  });
});

describe("parsePairs", () => {
  it("skips malformed entries and trims whitespace", () => {
    expect(parsePairs("a=1, nope , b = x=y ,,=z")).toEqual({ a: "1", b: "x=y" });
    expect(parsePairs(undefined)).toEqual({});
  });
});
