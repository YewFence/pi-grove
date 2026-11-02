import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

const testHome = mkdtempSync(join(tmpdir(), "ask-user-question-test-home-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.XDG_CONFIG_HOME;
  const configFile = join(testHome, ".pi", "extensions", "ask-user-question", "config.json");
  try {
    unlinkSync(configFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
});
