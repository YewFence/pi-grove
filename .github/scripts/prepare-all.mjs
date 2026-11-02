import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const data = JSON.parse(readFileSync(join(process.env.RUNNER_TEMP, "plans.json"), "utf8"));
for (const release of Array.isArray(data) ? data : [data]) {
  if (!release.changed) continue;
  const path = join(process.env.RUNNER_TEMP, `prepare-${release.package}`);
  const plan = join(process.env.RUNNER_TEMP, `plan-${release.package}.json`);
  writeFileSync(plan, JSON.stringify(release));
  execFileSync("git", ["worktree", "add", "--detach", path, release.base], { stdio: "inherit" });
  execFileSync("mise", ["trust"], { cwd: path, stdio: "inherit" });
  execFileSync("mise", ["run", "release:prepare", plan], { cwd: path, stdio: "inherit" });
  execFileSync("node", [".github/scripts/prepare-release.mjs"], { cwd: path, stdio: "inherit", env: { ...process.env, RELEASE_PLAN: plan } });
}
