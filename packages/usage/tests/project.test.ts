import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { detectProject } from "../src/project.js";

describe("detectProject", () => {
  it("finds the nearest jj root walking up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-project-"));
    mkdirSync(join(dir, ".jj"));
    mkdirSync(join(dir, "packages", "usage"), { recursive: true });
    const project = await detectProject(join(dir, "packages", "usage"));
    expect(project).toEqual({ root: dir, name: dir.split("/").pop() });
  });

  it("accepts a .git file (worktree) as a root marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-project-"));
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere");
    const project = await detectProject(dir);
    expect(project.root).toBe(dir);
  });

  it("falls back to the cwd basename outside any repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-project-"));
    const project = await detectProject(dir);
    expect(project.root).toBe(dir);
    expect(project.name).toBe(dir.split("/").pop());
  });
});
