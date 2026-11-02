import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectContextFiles,
  createWalkupCache,
  getWalkDirectories,
} from "../src/piCues/walkup.js";

const dirs: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-cues-walkup-"));
  dirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("getWalkDirectories", () => {
  it("walks from the file's directory up to the anchor, near to far", () => {
    // #given anchor /r and target /r/a/b/f.ts #then dirs [/r/a/b, /r/a, /r]
    const root = makeRoot();
    expect(getWalkDirectories(root, join(root, "a", "b", "f.ts"))).toEqual([
      join(root, "a", "b"),
      join(root, "a"),
      root,
    ]);
  });

  it("returns only the anchor for targets outside the anchor subtree", () => {
    const root = makeRoot();
    expect(getWalkDirectories(root, "/elsewhere/f.ts")).toEqual([]);
  });
});

describe("collectContextFiles", () => {
  it("collects files near to far across levels", () => {
    const root = makeRoot();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root");
    writeFileSync(join(root, "a", "AGENTS.md"), "a");
    writeFileSync(join(root, "a", "b", "CLAUDE.md"), "b");

    const cache = createWalkupCache();
    const files = collectContextFiles({
      anchorDir: root,
      targetFile: join(root, "a", "b", "f.ts"),
      fileNames: ["AGENTS.md", "CLAUDE.md"],
      cache,
    });
    expect(files.map((f) => f.path)).toEqual([
      join(root, "a", "b", "CLAUDE.md"),
      join(root, "a", "AGENTS.md"),
      join(root, "AGENTS.md"),
    ]);
  });

  it("does not trigger for targets outside the anchor subtree", () => {
    const root = makeRoot();
    writeFileSync(join(root, "AGENTS.md"), "root");
    const files = collectContextFiles({
      anchorDir: root,
      targetFile: "/elsewhere/f.ts",
      fileNames: ["AGENTS.md"],
      cache: createWalkupCache(),
    });
    expect(files).toEqual([]);
  });

  it("serves a cache hit without rediscovery", () => {
    const root = makeRoot();
    writeFileSync(join(root, "AGENTS.md"), "root");
    const cache = createWalkupCache();
    const options = {
      anchorDir: root,
      targetFile: join(root, "f.ts"),
      fileNames: ["AGENTS.md"],
      cache,
    };
    const first = collectContextFiles(options);
    const second = collectContextFiles(options);
    expect(second.map((f) => f.path)).toEqual(first.map((f) => f.path));
  });

  it("discovers a file created after a missing fingerprint was cached", () => {
    const root = makeRoot();
    const cache = createWalkupCache();
    const options = {
      anchorDir: root,
      targetFile: join(root, "f.ts"),
      fileNames: ["AGENTS.md"],
      cache,
    };

    expect(collectContextFiles(options)).toEqual([]);
    writeFileSync(join(root, "AGENTS.md"), "created later");
    expect(collectContextFiles(options).map((f) => f.path)).toEqual([join(root, "AGENTS.md")]);
  });

  it("invalidates the entry when a file's stat fingerprint changes", () => {
    const root = makeRoot();
    writeFileSync(join(root, "AGENTS.md"), "v1");
    const cache = createWalkupCache();
    const options = {
      anchorDir: root,
      targetFile: join(root, "f.ts"),
      fileNames: ["AGENTS.md"],
      cache,
    };
    collectContextFiles(options);

    const changed = new Date(Date.now() + 60_000);
    utimesSync(join(root, "AGENTS.md"), changed, changed);
    const entry = cache.entries.get(root);
    expect(entry).toBeDefined();
    collectContextFiles(options);
    // #then the fingerprint stored after revalidation reflects the new mtime
    expect(cache.entries.get(root)?.candidates[0]?.fingerprint).not.toBe(
      entry?.candidates[0]?.fingerprint,
    );
  });
});
