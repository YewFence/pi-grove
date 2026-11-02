import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const release = JSON.parse(readFileSync(process.env.RELEASE_PLAN, "utf8"));
if (!release.changed) process.exit(0);
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const branch = `release/${release.package}`;
run("git", ["config", "user.name", "github-actions[bot]"]);
run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
const remote = run("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
const expected = remote ? remote.split(/\s+/)[0] : "";
run("git", ["switch", "-c", branch]);
run("git", ["add", "--", `${release.path}/package.json`, `${release.path}/CHANGELOG.md`, "aube-lock.yaml"]);
run("git", ["-c", "commit.gpgsign=false", "commit", "-m", `chore(${release.package}): release ${release.version}`]);
run("git", ["push", `--force-with-lease=refs/heads/${branch}:${expected}`, "origin", `HEAD:refs/heads/${branch}`]);
const body = join(process.env.RUNNER_TEMP, `release-${release.package}.md`);
writeFileSync(body, `<!-- pi-grove-release: ${JSON.stringify({ tag: release.tag, base: release.base })} -->\n\n${release.notes}\n`);
const existing = JSON.parse(run("gh", ["pr", "list", "--head", branch, "--base", "main", "--state", "open", "--json", "number"]));
const title = `chore(${release.package}): release ${release.version}`;
if (existing.length) run("gh", ["pr", "edit", String(existing[0].number), "--title", title, "--body-file", body]);
else run("gh", ["pr", "create", "--head", branch, "--base", "main", "--title", title, "--body-file", body]);
// Explicit dispatch also runs checks for release branches created with GITHUB_TOKEN.
run("gh", ["workflow", "run", "ci.yml", "--ref", branch]);
