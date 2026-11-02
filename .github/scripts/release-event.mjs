import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
let tag;
let base = "";
if (process.env.GITHUB_EVENT_NAME === "pull_request") {
  const pr = event.pull_request;
  if (!pr.merged || pr.head.repo.full_name !== process.env.GITHUB_REPOSITORY || !pr.head.ref.startsWith("release/")) process.exit(0);
  const marker = pr.body?.match(/<!-- pi-grove-release: (\{[^\n]+\}) -->/);
  if (!marker) throw new Error("Release PR is missing its metadata");
  ({ tag, base } = JSON.parse(marker[1]));
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error("Invalid release base");
  if (!tag.startsWith(`${pr.head.ref.slice("release/".length)}-v`)) throw new Error("Release branch does not match tag");
} else tag = event.inputs?.tag ?? process.env.GITHUB_REF_NAME;
const result = JSON.parse(execFileSync("mise", ["run", "release:validate", tag, "--base", base], { encoding: "utf8" }));
const existingTags = execFileSync("git", ["tag", "--list", tag], { encoding: "utf8" }).trim();
if (existingTags) {
  const target = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
  if (target !== result.commit) throw new Error("Release tag already points to another commit");
}
appendFileSync(process.env.GITHUB_OUTPUT, `tag=${result.tag}\ncommit=${result.commit}\npackage=${result.package}\nready=true\n`);
