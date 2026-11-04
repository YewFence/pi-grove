import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { test } from "vitest";
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

  const require = createRequire(import.meta.url);
  const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const reportPath = join(root, "results.json");
  await execFileAsync(
    process.execPath,
    [
      vitest,
      "run",
      "test/rendering.test.ts",
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
        XDG_STATE_HOME: stateHome,
      },
      timeout: 10_000,
    },
  );

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.numTotalTests, 4);
  assert.equal(report.numPassedTests, 4);
  assert.equal(report.success, true);
  assert.equal(readFileSync(settingsPath, "utf8"), settings);
  assert.deepEqual(readdirSync(agentDir).sort(), ["settings.json", "settings.json.lock"]);
  assert.deepEqual(readdirSync(`${settingsPath}.lock`), []);
  assert.deepEqual(readdirSync(stateHome), []);
  assert.deepEqual(readdirSync(sessionDir), []);
});
