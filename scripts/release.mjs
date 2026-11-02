import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packageBySlug, packageFromTag, packages, root, run } from "./packages.mjs";

const git = (repository, ...args) => run("git", args, { cwd: repository });

export function fingerprint(repository, pkg, ref) {
  const output = run(
    "josh-filter",
    [`:/${pkg.path}`, ref, "--update", `refs/pi-grove/${pkg.slug}`],
    { cwd: repository },
  );
  const sha = output.split(/\s+/).at(-1);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Could not filter ${pkg.slug}: ${output}`);
  return sha;
}

export function plan(repository, slug, ref = "HEAD") {
  const pkg = packageBySlug(slug, repository);
  const base = git(repository, "rev-parse", `${ref}^{commit}`);
  const tags = git(
    repository,
    "tag",
    "--merged",
    base,
    "--list",
    `${slug}-v*`,
    "--sort=-version:refname",
  )
    .split("\n")
    .filter(Boolean);
  const previous = tags[0];
  const baseline = previous ?? git(repository, "rev-parse", "pi-grove-import^{commit}");
  const range = `${baseline}..${base}`;
  const context = JSON.parse(
    run(
      "git-cliff",
      [
        "--offline",
        "--config",
        resolve(repository, "cliff.toml"),
        "--include-path",
        `${pkg.path}/**`,
        "--tag-pattern",
        `^${slug}-v[0-9]`,
        "--context",
        range,
      ],
      { cwd: repository },
    ),
  );
  const commits = context.flatMap((release) => release.commits);
  const lastPackageCommit = git(repository, "log", "-1", "--format=%s", base, "--", pkg.path);
  const pendingPreparation =
    previous !== `${slug}-v${pkg.manifest.version}` &&
    lastPackageCommit.startsWith(`chore(${slug}): release `);
  const changed = !pendingPreparation && (commits.length > 0 || !previous);
  let version = pkg.manifest.version;
  if (previous && commits.length > 0) {
    const bumped = run(
      "git-cliff",
      [
        "--offline",
        "--config",
        resolve(repository, "cliff.toml"),
        "--include-path",
        `${pkg.path}/**`,
        "--tag-pattern",
        `^${slug}-v[0-9]`,
        "--bumped-version",
        range,
      ],
      { cwd: repository },
    );
    version = bumped.slice(`${slug}-v`.length);
  }
  const tag = `${slug}-v${version}`;
  const notes =
    commits.length > 0
      ? run(
          "git-cliff",
          [
            "--offline",
            "--config",
            resolve(repository, "cliff.toml"),
            "--include-path",
            `${pkg.path}/**`,
            "--tag-pattern",
            `^${slug}-v[0-9]`,
            "--tag",
            tag,
            "--strip",
            "all",
            range,
          ],
          { cwd: repository },
        )
      : `## ${pkg.manifest.name} ${version}\n\n- Initial release from pi-grove.\n${slug === "cues" ? "- Read global configuration from `<agent-dir>/extensions/pi-cues/config.toml` (`PI_CODING_AGENT_DIR` or `~/.pi/agent`); project configuration and host trust storage keep their existing paths.\n- Ship the extension source, authoring skill, and configuration schema together.\n" : ""}`;
  return {
    package: slug,
    path: pkg.path,
    name: pkg.manifest.name,
    previous: previous ?? null,
    version,
    tag,
    base,
    fingerprint: fingerprint(repository, pkg, base),
    changed,
    notes,
  };
}

export function prepare(repository, release) {
  const pkg = packageBySlug(release.package, repository);
  if (
    release.path !== pkg.path ||
    release.name !== pkg.manifest.name ||
    release.tag !== `${pkg.slug}-v${release.version}`
  )
    throw new Error("Release plan does not match the package");
  packageFromTag(release.tag, repository);
  if (git(repository, "rev-parse", "HEAD") !== release.base)
    throw new Error("Release plan was prepared from another commit");
  if (!release.changed) throw new Error("No package changes to release");
  if (fingerprint(repository, pkg, release.base) !== release.fingerprint)
    throw new Error("Release plan fingerprint does not match its base");
  const manifestPath = resolve(repository, pkg.path, "package.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...pkg.manifest, version: release.version }, null, 2)}\n`,
  );
  const changelog = resolve(repository, pkg.path, "CHANGELOG.md");
  let history = "";
  try {
    history = readFileSync(changelog, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  writeFileSync(changelog, `${release.notes.trim()}\n\n${history}`);
  run("aube", ["install", "--lockfile-only"], { cwd: repository });
}

export function validate(repository, tag, base = "", head = "HEAD") {
  const pkg = packageFromTag(tag, repository);
  const manifest = JSON.parse(git(repository, "show", `${head}:${pkg.path}/package.json`));
  if (manifest.name !== pkg.manifest.name || manifest.version !== pkg.version)
    throw new Error("Release tag does not match package name/version");
  if (base && fingerprint(repository, pkg, base) !== fingerprint(repository, pkg, `${head}^1`))
    throw new Error("Package changed since the release PR was prepared");
  if (base) {
    const files = git(repository, "diff", "--name-only", `${head}^1`, head)
      .split("\n")
      .filter(Boolean);
    const allowed = new Set([
      `${pkg.path}/package.json`,
      `${pkg.path}/CHANGELOG.md`,
      "aube-lock.yaml",
    ]);
    if (files.some((path) => !allowed.has(path)))
      throw new Error("Release PR contains changes outside its version, changelog, or lockfile");
    const before = JSON.parse(git(repository, "show", `${head}^1:${pkg.path}/package.json`));
    if (JSON.stringify({ ...before, version: manifest.version }) !== JSON.stringify(manifest))
      throw new Error("Release PR changes package fields other than version");
  }
  return {
    package: pkg.slug,
    path: pkg.path,
    name: manifest.name,
    tag,
    version: pkg.version,
    commit: git(repository, "rev-parse", `${head}^{commit}`),
  };
}

export function releaseNotes(repository, tag) {
  const pkg = packageFromTag(tag, repository);
  const changelog = git(repository, "show", `${tag}:${pkg.path}/CHANGELOG.md`);
  const next = changelog.indexOf("\n## ", changelog.indexOf("## ") + 3);
  return next < 0 ? changelog : changelog.slice(0, next);
}

export async function publish(repository, tag, dryRun) {
  const metadata = validate(repository, tag);
  if (git(repository, "rev-parse", `${tag}^{commit}`) !== metadata.commit)
    throw new Error("Checkout must exactly match the release tag");
  run("node", [resolve(repository, "scripts/check-packages.mjs"), metadata.package], {
    cwd: repository,
    stdio: "inherit",
  });
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(metadata.name)}/${encodeURIComponent(metadata.version)}`,
  );
  if (response.status === 200) {
    const existing = await response.json();
    if (existing.name !== metadata.name || existing.version !== metadata.version)
      throw new Error("Unexpected registry response");
    console.log(`${metadata.name}@${metadata.version} already exists`);
    return;
  }
  if (response.status !== 404) throw new Error(`Registry returned ${response.status}`);
  const args = [
    "publish",
    "--access",
    "public",
    "--no-git-checks",
    "--tag",
    metadata.version.includes("-") ? "next" : "latest",
  ];
  if (dryRun) args.push("--dry-run");
  else args.push("--provenance");
  run("aube", args, { cwd: resolve(repository, metadata.path), stdio: "inherit" });
}

async function main() {
  const [command, value, second, third] = process.argv.slice(2);
  if (command === "plan") {
    const result =
      value === "all"
        ? packages().map((pkg) => plan(root, pkg.slug, second))
        : plan(root, value, second);
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (!third || third === "-") process.stdout.write(json);
    else writeFileSync(third, json);
  } else if (command === "prepare") prepare(root, JSON.parse(readFileSync(value, "utf8")));
  else if (command === "validate")
    console.log(JSON.stringify(validate(root, value, second, third), null, 2));
  else if (command === "notes") writeFileSync(second, `${releaseNotes(root, value).trim()}\n`);
  else if (command === "publish") await publish(root, value, second === "true");
  else throw new Error(`Unknown release operation: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
