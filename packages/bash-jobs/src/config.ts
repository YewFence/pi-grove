import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse } from "smol-toml";
import type { CommandSourceHookConfig } from "./source-hooks.ts";

export interface SourceHookConfig {
  hooks: CommandSourceHookConfig[];
  diagnostics: string[];
}

/** Loads user-owned hooks; project configuration is intentionally not read. */
export function loadSourceHookConfig(agentDir = getAgentDir()): SourceHookConfig {
  const file = join(agentDir, "extensions", "pi-bash-jobs", "config.toml");
  const result: SourceHookConfig = { hooks: [], diagnostics: [] };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      result.diagnostics.push(`${file}: unable to read config`);
    }
    return result;
  }
  let config: Record<string, unknown>;
  try {
    config = parse(text);
  } catch (error) {
    result.diagnostics.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  if (config.version !== 1) {
    result.diagnostics.push(`${file}: version must be 1; config ignored`);
    return result;
  }
  for (const key of Object.keys(config)) {
    if (key !== "version" && key !== "source_hooks") {
      result.diagnostics.push(`${file}: unknown key ${key}`);
    }
  }
  if (config.source_hooks === undefined) return result;
  if (!Array.isArray(config.source_hooks)) {
    result.diagnostics.push(`${file}: source_hooks must be an array of tables`);
    return result;
  }
  for (const [index, entry] of config.source_hooks.entries()) {
    const source = `${file}: source_hooks[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      result.diagnostics.push(`${source}: expected a table; skipped`);
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const unknownKeys = Object.keys(raw).filter(
      (key) => !["name", "command", "timeout_ms"].includes(key),
    );
    if (unknownKeys.length) {
      result.diagnostics.push(`${source}: unknown keys ${unknownKeys.join(", ")}; skipped`);
      continue;
    }
    if (typeof raw.name !== "string" || !raw.name.trim() || /[\r\n\0]/.test(raw.name)) {
      result.diagnostics.push(`${source}: name must be a non-empty single line; skipped`);
      continue;
    }
    if (
      !Array.isArray(raw.command) ||
      !raw.command.length ||
      raw.command.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      !raw.command[0].trim()
    ) {
      result.diagnostics.push(
        `${source}: command must be an argv array with a non-empty executable; skipped`,
      );
      continue;
    }
    const timeoutMs = raw.timeout_ms ?? 3_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      (timeoutMs as number) <= 0 ||
      (timeoutMs as number) > 2_147_483_647
    ) {
      result.diagnostics.push(
        `${source}: timeout_ms must be an integer between 1 and 2147483647; skipped`,
      );
      continue;
    }
    result.hooks.push({
      name: raw.name,
      command: raw.command as string[],
      timeoutMs: timeoutMs as number,
    });
  }
  return result;
}
