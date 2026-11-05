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
  /** Whether standard OTEL_* variables were allowed as fallbacks. */
  usedOtelFallback: boolean;
}

/**
 * Configuration is namespaced by default: only PI_USAGE_* variables are read,
 * so loading this extension can never silently redirect another OTLP
 * instrumenter that shares the process environment. Set
 * PI_USAGE_USE_OTEL_ENV=true to opt into the standard OTEL_* fallbacks (and
 * then PI_USAGE_* still wins). Without an endpoint the extension stays inert.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): UsageConfig {
  const stateFile =
    env.PI_USAGE_STATE_FILE ??
    join(
      env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "pi-usage",
      "pending-spans.json",
    );
  const useOtelEnv = isTrue(env.PI_USAGE_USE_OTEL_ENV);
  const otel: NodeJS.ProcessEnv = useOtelEnv ? env : {};
  const base: UsageConfig = {
    enabled: false,
    headers: parsePairs(
      env.PI_USAGE_OTLP_TRACES_HEADERS ??
        env.PI_USAGE_OTLP_HEADERS ??
        otel.OTEL_EXPORTER_OTLP_TRACES_HEADERS ??
        otel.OTEL_EXPORTER_OTLP_HEADERS,
    ),
    resourceAttributes: parsePairs(
      env.PI_USAGE_RESOURCE_ATTRIBUTES ?? otel.OTEL_RESOURCE_ATTRIBUTES,
    ),
    entityMode: env.PI_USAGE_ENTITY === "off" ? "off" : "path",
    projectOverride: env.PI_USAGE_PROJECT || undefined,
    stateFile,
    usedOtelFallback: useOtelEnv,
  };
  const toggle = (env.PI_USAGE_ENABLED ?? "").toLowerCase();
  if (["0", "false", "no", "off"].includes(toggle)) {
    return { ...base, disabledReason: "disabled by PI_USAGE_ENABLED" };
  }
  const signal =
    env.PI_USAGE_OTLP_TRACES_ENDPOINT?.trim() ||
    (useOtelEnv ? otel.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() : undefined);
  const generic =
    env.PI_USAGE_OTLP_ENDPOINT?.trim().replace(/\/+$/, "") ||
    (useOtelEnv ? otel.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, "") : undefined);
  const endpoint = signal || (generic ? `${generic}/v1/traces` : undefined);
  if (!endpoint) {
    return { ...base, disabledReason: "no PI_USAGE_OTLP endpoint configured" };
  }
  return { ...base, enabled: true, endpoint };
}

function isTrue(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());
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
