import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("rendering tests ignore inherited settings locks and state directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bash-jobs-inherited-"));
  const agentDir = join(root, "agent");
  const stateHome = join(root, "state");
  const sessionDir = join(root, "sessions");
  for (const directory of [agentDir, stateHome, sessionDir]) mkdirSync(directory);
  const settingsPath = join(agentDir, "settings.json");
  const settings = JSON.stringify({ shellCommandPrefix: "exit 71" });
  writeFileSync(settingsPath, settings);
  // A fresh lock reproduces contention without touching another process's files.
  mkdirSync(`${settingsPath}.lock`);

  const env = { ...process.env };
  // The subprocess needs its own test runner, not the parent's internal child protocol.
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--max-old-space-size=192",
      "--test",
      "--test-reporter=tap",
      fileURLToPath(new URL("./rendering.test.ts", import.meta.url)),
    ],
    {
      env: {
        ...env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
        XDG_STATE_HOME: stateHome,
      },
      timeout: 10_000,
    },
  );

  assert.match(stdout, /tests 4/);
  assert.match(stdout, /pass 4/);
  assert.equal(readFileSync(settingsPath, "utf8"), settings);
  assert.deepEqual(readdirSync(agentDir).sort(), ["settings.json", "settings.json.lock"]);
  assert.deepEqual(readdirSync(`${settingsPath}.lock`), []);
  assert.deepEqual(readdirSync(stateHome), []);
  assert.deepEqual(readdirSync(sessionDir), []);
});
