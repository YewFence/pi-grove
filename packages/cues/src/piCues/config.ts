/**
 * Config discovery, parsing and validation.
 *
 * Two levels, same relative path under each root: global
 * `~/.pi/agent/extensions/pi-cues/config.toml` (the user's own, unrestricted)
 * and project `<cwd>/.pi/extensions/pi-cues/config.toml` (its parent directory
 * is a pi trust-requiring resource, so pi asks for trust before the project
 * can ship any pi-cues config). Triggers of the two levels are appended
 * (global baseline first). Invalid entries become diagnostics and are
 * skipped; the rest of the config stays active.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parse as parseToml } from "smol-toml";

import type { ActionKind, CueDiagnostic, ToolName, Trigger, TriggerWhen } from "./types.js";

const TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "read", "edit", "write"]);
const PATH_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "edit", "write"]);
const ACTION_NAMES: ReadonlySet<string> = new Set(["skill", "file", "walkup", "inline", "exec"]);
const WHEN_KEYS: ReadonlySet<string> = new Set(["command", "path"]);
const CONFIG_VERSION = 1;

/** Config path relative to the agent directory or project `.pi/` root. */
const CONFIG_SUBPATH: ReadonlyArray<string> = ["extensions", "pi-cues", "config.toml"];

export interface LoadedConfig {
  triggers: Trigger[];
  diagnostics: CueDiagnostic[];
  /** Config files actually loaded, global first. */
  files: string[];
  /** True when the project config was skipped because the directory is untrusted. */
  projectUntrusted: boolean;
  /** False only when the global config sets `[telemetry] enabled = false`. Default true. */
  telemetry: boolean;
}

/**
 * Zero-config baseline: every read/edit/write walks up to the session cwd
 * collecting AGENTS.md. Merged as level zero (before global and project);
 * `defaults = false` in any config file disables it.
 */
function defaultTriggers(cwd: string): Trigger[] {
  return [
    {
      tools: ["read", "edit", "write"],
      when: undefined,
      action: "walkup",
      targets: ["AGENTS.md"],
      excludes: [],
      configDir: cwd,
      source: "<builtin defaults>",
    },
  ];
}

export interface LoadConfigOptions {
  cwd: string;
  /** pi's agent data directory (PI_CODING_AGENT_DIR or the ~/.pi/agent default). */
  agentDir: string;
  /**
   * Whether the project directory is trusted (ctx.isProjectTrusted()).
   * Untrusted project config is parsed for diagnostics but its triggers are
   * never loaded: a globally installed extension must not execute whatever a
   * cloned repository ships in .pi/extensions/pi-cues/config.toml.
   */
  projectTrusted?: boolean;
}

export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const config: LoadedConfig = {
    triggers: [],
    diagnostics: [],
    files: [],
    projectUntrusted: false,
    telemetry: true,
  };
  const globalLevel = loadLevel(options.agentDir, "global", true, config);
  const projectLevel = loadLevel(
    join(options.cwd, ".pi"),
    "project",
    options.projectTrusted ?? true,
    config,
  );
  config.projectUntrusted = !projectLevel.trusted && projectLevel.file !== undefined;
  config.telemetry = globalLevel.telemetry !== false;
  if (globalLevel.defaults && projectLevel.defaults) {
    config.triggers.push(...defaultTriggers(options.cwd));
  }
  config.triggers.push(...globalLevel.triggers, ...projectLevel.triggers);
  return config;
}

interface LevelResult {
  triggers: Trigger[];
  defaults: boolean;
  trusted: boolean;
  file: string | undefined;
  /** Explicit `[telemetry] enabled` from this level; undefined when absent or invalid. */
  telemetry: boolean | undefined;
}

function loadLevel(
  baseDir: string,
  scope: "global" | "project",
  trusted: boolean,
  config: LoadedConfig,
): LevelResult {
  const empty: LevelResult = {
    triggers: [],
    defaults: true,
    trusted,
    file: undefined,
    telemetry: undefined,
  };
  const file = join(baseDir, ...CONFIG_SUBPATH);
  if (!existsSync(file)) {
    return empty;
  }
  empty.file = file;

  const parsed = parseConfigFile(file, config);
  if (parsed === undefined) {
    return empty;
  }
  config.files.push(file);

  const defaultsValue = parsed["defaults"];
  if (defaultsValue !== undefined && typeof defaultsValue !== "boolean") {
    config.diagnostics.push({
      severity: "warning",
      source: file,
      message: "`defaults` must be a boolean",
    });
  }
  // Untrusted project config is ignored wholesale — including any
  // `defaults` override it tries to make.
  if (!trusted) {
    config.diagnostics.push({
      severity: "warning",
      source: file,
      message: "Project is not trusted; config ignored",
    });
    return { triggers: [], defaults: true, trusted, file, telemetry: undefined };
  }
  const defaults = defaultsValue !== false;
  const telemetry = parseTelemetry(parsed["telemetry"], file, scope, config);

  const rawTriggers = parsed["triggers"];
  if (rawTriggers === undefined) {
    return { triggers: [], defaults, trusted, file, telemetry };
  }
  if (!Array.isArray(rawTriggers)) {
    config.diagnostics.push({
      severity: "error",
      source: file,
      message: "`triggers` must be an array",
    });
    return { triggers: [], defaults, trusted, file, telemetry };
  }

  const triggers: Trigger[] = [];
  for (const [index, raw] of rawTriggers.entries()) {
    const source = `${file} triggers[${index}]`;
    if (!isRecord(raw)) {
      config.diagnostics.push({
        severity: "warning",
        source,
        message: "Entry must be a table; skipped",
      });
      continue;
    }

    const result = validateTrigger(raw, dirname(file), source, scope);
    if (result.trigger !== undefined) {
      triggers.push(result.trigger);
      continue;
    }
    config.diagnostics.push(...result.diagnostics);
  }
  return { triggers, defaults, trusted, file, telemetry };
}

/**
 * Telemetry is a machine-level knob for the user running the agent, so only
 * the global config may toggle it. A project entry (a cloned repository's)
 * is ignored with a warning; its parsed value never leaks into the result.
 */
function parseTelemetry(
  value: unknown,
  file: string,
  scope: "global" | "project",
  config: LoadedConfig,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    config.diagnostics.push({
      severity: "warning",
      source: file,
      message: "`telemetry` must be a table",
    });
    return undefined;
  }
  const unknownKeys = Object.keys(value).filter((key) => key !== "enabled");
  if (unknownKeys.length > 0) {
    config.diagnostics.push({
      severity: "warning",
      source: file,
      message: "`telemetry` has unknown keys: " + unknownKeys.join(", "),
    });
  }
  if (scope === "project") {
    config.diagnostics.push({
      severity: "warning",
      source: file,
      message: "`telemetry` is only valid in the global config; ignored",
    });
    return undefined;
  }
  const enabled = value["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    config.diagnostics.push({
      severity: "warning",
      source: file,
      message: "`telemetry.enabled` must be a boolean",
    });
    return undefined;
  }
  return enabled;
}

function parseConfigFile(file: string, config: LoadedConfig): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(file, "utf8"));
  } catch (error) {
    config.diagnostics.push({ severity: "error", source: file, message: errorMessage(error) });
    return undefined;
  }
  if (!isRecord(parsed)) {
    config.diagnostics.push({
      severity: "error",
      source: file,
      message: "Top level must be a table",
    });
    return undefined;
  }

  const version = parsed["version"];
  if (version !== CONFIG_VERSION) {
    config.diagnostics.push({
      severity: "error",
      source: file,
      message: `Unsupported version: ${JSON.stringify(version)} (expected ${CONFIG_VERSION})`,
    });
    return undefined;
  }

  return parsed;
}

interface TriggerValidation {
  trigger?: Trigger;
  diagnostics: CueDiagnostic[];
}

function validateTrigger(
  raw: Record<string, unknown>,
  configDir: string,
  source: string,
  scope: "global" | "project",
): TriggerValidation {
  const reject = (message: string): TriggerValidation => ({
    diagnostics: [{ severity: "warning", source, message: `${message}; skipped` }],
  });

  const tools = parseTools(raw["tools"]);
  if (tools === undefined) {
    return reject(`Invalid tools: ${JSON.stringify(raw["tools"])}`);
  }

  const action = raw["action"];
  if (typeof action !== "string" || !ACTION_NAMES.has(action)) {
    return reject(`Invalid action: ${JSON.stringify(raw["action"])}`);
  }
  const actionKind = action as ActionKind;

  const targets = parseStringList(raw["target"]);
  if (targets === undefined || targets.length === 0) {
    return reject(`Invalid target: ${JSON.stringify(raw["target"])}`);
  }

  // Project-level file targets must stay inside the config directory: a
  // cloned repository has no business pointing the user's agent at files
  // outside itself. Global config is the user's own and unrestricted.
  if (scope === "project" && action === "file") {
    for (const target of targets) {
      const resolved = resolve(configDir, target);
      if (!isSubpath(configDir, resolved)) {
        return reject(`file target escapes the config directory: ${target}`);
      }
    }
  }

  if (actionKind === "walkup" && tools.some((tool) => !PATH_TOOL_NAMES.has(tool))) {
    // Walk-up collects context files for path operations only.
    return reject("walkup triggers must not listen to bash");
  }

  if (actionKind === "exec" && tools.some((tool) => tool !== "bash")) {
    // exec runs a shell command; path events give it nothing to react to.
    return reject("exec triggers must listen to bash only");
  }
  if (actionKind === "exec" && !isRecord(raw["when"])) {
    return reject("exec triggers require when.command");
  }

  const excludes = parseExcludes(raw["exclude"], actionKind);
  if (typeof excludes === "string") {
    return reject(excludes);
  }

  const when = parseWhen(raw["when"], tools, actionKind);
  if (!when.ok) {
    return reject(`Invalid when: ${JSON.stringify(raw["when"])}`);
  }

  return {
    trigger: { tools, when: when.when, action: actionKind, targets, excludes, configDir, source },
    diagnostics: [],
  };
}

/** Returns parsed patterns, or an error message when the entry is invalid. */
function parseExcludes(value: unknown, action: ActionKind): string[] | string {
  if (value === undefined) {
    return [];
  }
  if (action !== "walkup") {
    return "exclude is only valid on walkup triggers";
  }
  const patterns = parseStringList(value);
  if (patterns === undefined || patterns.some((pattern) => pattern.startsWith("!"))) {
    return "exclude patterns must be non-empty strings without a leading '!'";
  }
  return patterns;
}

function parseTools(value: unknown): ToolName[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const tools: ToolName[] = [];
  for (const tool of value) {
    if (typeof tool !== "string" || !TOOL_NAMES.has(tool)) {
      return undefined;
    }
    tools.push(tool as ToolName);
  }
  return tools;
}

function parseStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.length === 0 ? undefined : [value];
  }
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      return undefined;
    }
    list.push(item);
  }
  return list;
}

type WhenValidation = { ok: true; when: TriggerWhen | undefined } | { ok: false };

function parseWhen(value: unknown, tools: ToolName[], action: ActionKind): WhenValidation {
  if (value === undefined) {
    // Only walkup may omit `when`: every listed path event triggers it.
    return action === "walkup" ? { ok: true, when: undefined } : { ok: false };
  }
  if (!isRecord(value)) {
    return { ok: false };
  }

  const when: TriggerWhen = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!WHEN_KEYS.has(key)) {
      return { ok: false };
    }
    const patterns = parseStringList(raw);
    if (patterns === undefined) {
      return { ok: false };
    }
    if (key === "command") {
      if (!tools.includes("bash")) {
        return { ok: false };
      }
      when.command = patterns;
      continue;
    }
    if (!tools.some((tool) => PATH_TOOL_NAMES.has(tool))) {
      return { ok: false };
    }
    when.path = patterns;
  }

  return Object.keys(when).length === 0 ? { ok: false } : { ok: true, when };
}

function isSubpath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
