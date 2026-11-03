import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

/** Isolates pi settings, sessions and telemetry for a test and restores the caller's environment. */
export function isolateTestEnvironment(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-bash-jobs-test-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const stateHome = join(root, "state");
  const sessionDir = join(root, "sessions");
  for (const directory of [cwd, agentDir, stateHome, sessionDir]) {
    mkdirSync(directory);
  }
  const overrides = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    XDG_STATE_HOME: stateHome,
  };
  for (const [key, value] of Object.entries(overrides)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  return { cwd, agentDir, stateHome, sessionDir };
}
