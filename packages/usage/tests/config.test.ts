import { describe, expect, it } from "vitest";

import { loadConfig, parsePairs } from "../src/config.js";

describe("loadConfig", () => {
  it("stays inert without an endpoint", () => {
    const config = loadConfig({});
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toMatch(/endpoint/);
    expect(config.endpoint).toBeUndefined();
  });

  it("appends /v1/traces to the generic OTel endpoint", () => {
    const config = loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo:4318/" });
    expect(config.enabled).toBe(true);
    expect(config.endpoint).toBe("http://tempo:4318/v1/traces");
  });

  it("uses the signal-specific endpoint verbatim and lets it win", () => {
    const config = loadConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://cloud.example.com/otlp/v1/traces",
    });
    expect(config.endpoint).toBe("https://cloud.example.com/otlp/v1/traces");
  });

  it("parses headers with the signal-specific list winning", () => {
    const config = loadConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Basic generic",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Basic specific, x-scope-orgid=42",
    });
    expect(config.headers).toEqual({ authorization: "Basic specific", "x-scope-orgid": "42" });
  });

  it("parses resource attributes", () => {
    const config = loadConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo:4318",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod,service.namespace=laptop",
    });
    expect(config.resourceAttributes).toEqual({
      "deployment.environment": "prod",
      "service.namespace": "laptop",
    });
  });

  it("honors the explicit disable toggle", () => {
    const config = loadConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo:4318",
      PI_USAGE_ENABLED: "0",
    });
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toMatch(/PI_USAGE_ENABLED/);
  });

  it("supports entity off mode and project override", () => {
    const config = loadConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo:4318",
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
