import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { packages, root, run } from "./packages.mjs";

const selection = process.argv[2] ?? "all";
const selected = packages().filter((pkg) => selection === "all" || pkg.slug === selection);
assert.ok(selected.length, `Unknown package: ${selection}`);
for (const pkg of selected) {
  assert.ok(
    pkg.manifest.scripts?.test && pkg.manifest.scripts?.typecheck,
    `${pkg.slug} must define test and typecheck scripts`,
  );
  const temporary = mkdtempSync(join(tmpdir(), `pi-grove-pack-${pkg.slug}-`));
  const result = JSON.parse(
    run("aube", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
      cwd: resolve(root, pkg.path),
    }),
  );
  const packed = Array.isArray(result) ? result[0] : result;
  run("tar", ["-xzf", resolve(temporary, packed.filename), "-C", temporary]);
  const unpacked = join(temporary, "package");
  const manifest = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8"));
  assert.equal(manifest.name, pkg.manifest.name);
  assert.equal(manifest.version, pkg.manifest.version);
  const files = new Set(packed.files.map((file) => file.path));
  assert.ok(files.has("LICENSE"), `${pkg.slug} must ship its license`);
  if (pkg.slug === "bash-jobs") {
    const skillPath = "resources/bash-jobs-debug/SKILL.md";
    assert.ok(files.has(skillPath), "bash-jobs must ship its on-demand debug skill");
    assert.equal(
      manifest.pi.skills,
      undefined,
      "bash-jobs debug skill must stay out of the skill catalog",
    );
    const envelope = await import(pathToFileURL(join(unpacked, "src/envelope.ts")).href);
    assert.equal(envelope.DEBUG_SKILL_PATH, join(unpacked, skillPath));
    assert.ok(
      readFileSync(envelope.DEBUG_SKILL_PATH, "utf8").includes(envelope.DEBUG_SKILL_DESCRIPTION),
    );
    assert.ok(
      envelope
        .formatDiagnostic({ action: "source-hook", message: "failed" }, true)
        .includes(envelope.DEBUG_SKILL_PATH),
    );
  }
  for (const resource of manifest.pi.extensions ?? []) {
    assert.ok(files.has(resource.replace(/^\.\//, "")), `${pkg.slug} does not ship ${resource}`);
  }
  for (const resource of manifest.pi.skills ?? []) {
    assert.ok(
      [...files].some(
        (file) =>
          file.startsWith(`${resource.replace(/^\.\//, "")}/`) && file.endsWith("/SKILL.md"),
      ),
      `${pkg.slug} does not ship skills at ${resource}`,
    );
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    assert.ok(
      !dependency.startsWith("@earendil-works/pi-") && dependency !== "typebox",
      `${dependency} must be a host peer`,
    );
    const target = join(unpacked, "node_modules", dependency);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(resolve(root, pkg.path, "node_modules", dependency)), target, "dir");
  }
  const overrides = {
    PI_CODING_AGENT_DIR: join(temporary, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(temporary, "sessions"),
    XDG_STATE_HOME: join(temporary, "state"),
  };
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const loader = new DefaultResourceLoader({
      cwd: temporary,
      agentDir: overrides.PI_CODING_AGENT_DIR,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: manifest.pi.extensions.map((path) => resolve(unpacked, path)),
    });
    await loader.reload();
    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, [], `${pkg.slug} failed to load its packed extension`);
    assert.equal(extensions.extensions.length, manifest.pi.extensions.length);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  console.log(`${manifest.name}@${manifest.version}: tarball and pi loader verified`);
}
