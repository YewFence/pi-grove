import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { fingerprint, plan, prepare, validate } from "../scripts/release.mjs";
import { packageBySlug, root } from "../scripts/packages.mjs";

function fixture() {
  const repository = mkdtempSync(join(tmpdir(), "pi-grove-release-test-"));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Release test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Release test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repository,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  copyFileSync(join(root, "cliff.toml"), join(repository, "cliff.toml"));
  for (const slug of ["a", "b"]) {
    mkdirSync(join(repository, "packages", slug), { recursive: true });
    writeFileSync(
      join(repository, "packages", slug, "package.json"),
      JSON.stringify({
        name: `@pi-grove/${slug}`,
        version: "0.1.0",
        pi: { extensions: ["index.ts"] },
      }),
    );
    writeFileSync(join(repository, "packages", slug, "index.ts"), "export default () => {};\n");
  }
  const commit = (message, path, content) => {
    if (path) writeFileSync(join(repository, path), content);
    git("add", ".");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  commit("chore: import packages");
  git("tag", "pi-grove-import");
  return { repository, git, commit };
}

test("unreleased packages receive independent initial versions", () => {
  const f = fixture();
  const release = plan(f.repository, "a");
  assert.equal(release.tag, "a-v0.1.0");
  assert.equal(release.changed, true);
  assert.match(release.notes, /Initial release/);
});

test("path and tag filters isolate patch and feature version bumps", () => {
  const f = fixture();
  f.git("tag", "a-v0.1.0");
  f.commit("feat(b): unrelated feature", "packages/b/index.ts", "export default () => 1;\n");
  assert.equal(plan(f.repository, "a").changed, false);
  f.commit("fix(a): repair output", "packages/a/index.ts", "export default () => 2;\n");
  const patch = plan(f.repository, "a");
  assert.equal(patch.version, "0.1.1");
  assert.match(patch.notes, /repair output/);
  assert.doesNotMatch(patch.notes, /unrelated feature/);
  f.commit("feat: new a capability", "packages/a/index.ts", "export default () => 3;\n");
  assert.equal(plan(f.repository, "a").version, "0.2.0");
});

test("release preparation updates only release files and is not a new release trigger", () => {
  const f = fixture();
  writeFileSync(
    join(f.repository, "package.json"),
    JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"] }),
  );
  f.commit("chore: workspace");
  const release = plan(f.repository, "a");
  prepare(f.repository, release);
  assert.equal(
    JSON.parse(readFileSync(join(f.repository, "packages/a/package.json"), "utf8")).version,
    "0.1.0",
  );
  assert.match(
    readFileSync(join(f.repository, "packages/a/CHANGELOG.md"), "utf8"),
    /Initial release/,
  );
  f.commit("chore(a): release 0.1.0");
  assert.equal(plan(f.repository, "a").changed, false);
  f.git("tag", "a-v0.1.0");
  assert.equal(plan(f.repository, "a").changed, false);
  assert.throws(() => prepare(f.repository, release), /another commit/);
  f.commit("fix(a): next fix", "packages/a/index.ts", "export default () => 3;\n");
  const next = plan(f.repository, "a");
  prepare(f.repository, next);
  f.commit(`chore(a): release ${next.version}`);
  assert.equal(plan(f.repository, "a").changed, false);
});

test("Josh fingerprint ignores sibling commits and detects reverted package history", () => {
  const f = fixture();
  const pkg = packageBySlug("a", f.repository);
  const original = fingerprint(f.repository, pkg, "HEAD");
  f.commit("fix(b): sibling", "packages/b/index.ts", "export default () => 1;\n");
  assert.equal(fingerprint(f.repository, pkg, "HEAD"), original);
  f.commit("fix(a): edit", "packages/a/index.ts", "export default () => 2;\n");
  f.commit("revert: edit", "packages/a/index.ts", "export default () => {};\n");
  assert.notEqual(fingerprint(f.repository, pkg, "HEAD"), original);
});

test("release freshness accepts sibling changes and rejects new package changes", () => {
  const f = fixture();
  const base = f.git("rev-parse", "HEAD");
  f.commit("fix(b): sibling", "packages/b/index.ts", "export default () => 1;\n");
  const path = join(f.repository, "packages/a/package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  f.commit(
    "chore: release a",
    "packages/a/package.json",
    JSON.stringify({ ...manifest, version: "0.2.0" }),
  );
  assert.equal(validate(f.repository, "a-v0.2.0", base).version, "0.2.0");
  assert.throws(() => validate(f.repository, "a-v9.0.0"), /does not match/);
  f.commit("fix(a): more work", "packages/a/index.ts", "export default () => 2;\n");
  f.commit("chore: refresh changelog", "packages/a/CHANGELOG.md", "## 0.2.0\n");
  assert.throws(() => validate(f.repository, "a-v0.2.0", base), /changed since/);
});
