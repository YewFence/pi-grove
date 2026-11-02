/**
 * Explicit trust decisions read from pi's ProjectTrustStore file.
 *
 * Walk-up collection only runs for projects the user explicitly trusted.
 * `ctx.isProjectTrusted()` cannot be the source: it answers "were protected
 * resources withheld", so it returns true for resource-less projects even
 * with a saved "Do not trust" decision (pi issue #10947). The store file is
 * the only source distinguishing true / false / no-decision.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** pi's agent data directory: follow PI_CODING_AGENT_DIR like any extension. */
export function resolveAgentDir(): string {
  return process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
}

/**
 * Nearest non-null decision for cwd or an ancestor, mirroring how /trust
 * resolves a path. null when no entry exists anywhere on the chain; read
 * failures also fail closed to null. Store keys are canonical paths, so cwd
 * is resolved through realpath before the walk.
 */
export function effectiveTrustDecision(cwd: string, agentDir: string): boolean | null {
  const entries = readTrustEntries(join(agentDir, "trust.json"));
  if (entries === undefined) {
    return null;
  }
  let dir: string;
  try {
    dir = realpathSync(resolve(cwd));
  } catch {
    dir = resolve(cwd);
  }
  for (;;) {
    const decision = entries.get(dir);
    if (decision === true || decision === false) {
      return decision;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function readTrustEntries(path: string): Map<string, boolean> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const entries = new Map<string, boolean>();
  for (const [key, value] of Object.entries(parsed)) {
    if (value === true || value === false) {
      entries.set(key, value);
    }
  }
  return entries;
}
