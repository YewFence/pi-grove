import { homedir } from "node:os";
import { join } from "node:path";

export interface UsageConfig {
  enabled: boolean;
  disabledReason?: string;
  endpoint?: string;
  headers: Record<string, string>;
  resourceAttributes: Record<string, string>;
  entityMode: "path" | "off";
  projectOverride?: string;
  stateFile: string;
}

/**
 * Configuration follows the standard OTel exporter environment variables, so
 * the extension behaves like any other OTLP-speaking process. No endpoint
 * means the extension stays inert; nothing is ever sent anywhere by default.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): UsageConfig {
  const stateFile =
    env.PI_USAGE_STATE_FILE ??
    join(
      env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "pi-usage",
      "pending-spans.json",
    );
  const base: UsageConfig = {
    enabled: false,
    headers: parsePairs(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS),
    resourceAttributes: parsePairs(env.OTEL_RESOURCE_ATTRIBUTES),
    entityMode: env.PI_USAGE_ENTITY === "off" ? "off" : "path",
    projectOverride: env.PI_USAGE_PROJECT || undefined,
    stateFile,
  };
  const toggle = (env.PI_USAGE_ENABLED ?? "").toLowerCase();
  if (["0", "false", "no", "off"].includes(toggle)) {
    return { ...base, disabledReason: "disabled by PI_USAGE_ENABLED" };
  }
  const signal = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const generic = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, "");
  const endpoint = signal || (generic ? `${generic}/v1/traces` : undefined);
  if (!endpoint) {
    return { ...base, disabledReason: "no OTLP endpoint configured" };
  }
  return { ...base, enabled: true, endpoint };
}

/** Parses the OTel `key=value,key2=value2` header/attribute list format. */
export function parsePairs(raw: string | undefined): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const entry of (raw ?? "").split(",")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (key) pairs[key] = value;
  }
  return pairs;
}
