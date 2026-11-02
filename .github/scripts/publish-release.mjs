import { execFileSync } from "node:child_process";
import { join } from "node:path";

const tag = process.env.RELEASE_TAG;
const [owner, name] = process.env.GITHUB_REPOSITORY.split("/");
const existing = JSON.parse(execFileSync("gh", ["api", "graphql", "-f", "query=query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){url}}}", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `tag=${tag}`], { encoding: "utf8" }));
if (existing.errors) throw new Error(JSON.stringify(existing.errors));
if (!existing.data.repository) throw new Error("Repository could not be resolved");
if (existing.data.repository.release) console.log(existing.data.repository.release.url);
else {
  const args = ["release", "create", tag, "--verify-tag", "--title", tag, "--notes-file", join(process.env.RUNNER_TEMP, "notes.md"), "--latest=false"];
  if (tag.slice(tag.lastIndexOf("-v") + 2).includes("-")) args.push("--prerelease");
  execFileSync("gh", args, { stdio: "inherit" });
}
