import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));

export function run(command, args, options = {}) {
  return (
    execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      ...options,
    }) ?? ""
  ).trim();
}

export function packages(repository = root) {
  return readdirSync(resolve(repository, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = `packages/${entry.name}`;
      const manifest = JSON.parse(readFileSync(resolve(repository, path, "package.json"), "utf8"));
      return { slug: entry.name, path, manifest };
    })
    .filter((pkg) => !pkg.manifest.private && pkg.manifest.pi);
}

export function packageBySlug(slug, repository = root) {
  const pkg = packages(repository).find((entry) => entry.slug === slug);
  if (!pkg) throw new Error(`Unknown extension package: ${slug}`);
  return pkg;
}

export function packageFromTag(tag, repository = root) {
  const pkg = packages(repository).find((entry) => tag.startsWith(`${entry.slug}-v`));
  if (
    !pkg ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(tag.slice(pkg.slug.length + 2))
  ) {
    throw new Error(`Invalid package release tag: ${tag}`);
  }
  return { ...pkg, version: tag.slice(pkg.slug.length + 2) };
}
