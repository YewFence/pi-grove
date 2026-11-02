import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSkillBlock, resolveSkill, stripFrontmatter } from "../src/piCues/skills.js";

const dirs: string[] = [];

function makeSkill(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "pi-cues-skill-"));
  dirs.push(root);
  const path = join(root, "SKILL.md");
  writeFileSync(path, body);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakePi(names: Record<string, string>) {
  return {
    getCommands: () =>
      Object.entries(names).map(([name, path]) => ({
        name: `skill:${name}`,
        description: name,
        source: "skill" as const,
        sourceInfo: { path, source: "test", scope: "user" as const, origin: "top-level" as const },
      })),
  };
}

describe("resolveSkill", () => {
  it("resolves a skill name through pi's command list", () => {
    // #given getCommands lists skill:jj-cli #when resolving jj-cli #then its path is returned
    const pi = fakePi({ "jj-cli": "/skills/jj-cli/SKILL.md" });
    expect(resolveSkill(pi, "jj-cli")).toEqual({ name: "jj-cli", path: "/skills/jj-cli/SKILL.md" });
  });

  it("returns null for unknown skills", () => {
    expect(resolveSkill(fakePi({}), "nope")).toBeNull();
  });

  it("ignores non-skill commands", () => {
    const pi = {
      getCommands: () => [
        {
          name: "jj-cli",
          source: "extension" as const,
          sourceInfo: {
            path: "/x",
            source: "t",
            scope: "user" as const,
            origin: "top-level" as const,
          },
        },
      ],
    };
    expect(resolveSkill(pi, "jj-cli")).toBeNull();
  });
});

describe("loadSkillBlock", () => {
  it("strips frontmatter and wraps the body in pi's skill block format", () => {
    const path = makeSkill("---\nname: jj-cli\ndescription: d\n---\n\nUse jj carefully.\n");
    const block = loadSkillBlock({ name: "jj-cli", path });
    expect(block).toBe(
      `<skill name="jj-cli" location="${path}">\nReferences are relative to ${dirname(path)}.\n\nUse jj carefully.\n</skill>`,
    );
  });

  it("returns null for an unreadable file", () => {
    expect(loadSkillBlock({ name: "x", path: join(tmpdir(), "nope", "SKILL.md") })).toBeNull();
  });
});

describe("stripFrontmatter", () => {
  it("returns content without frontmatter unchanged", () => {
    expect(stripFrontmatter("plain\nbody")).toBe("plain\nbody");
  });

  it("strips CRLF frontmatter", () => {
    expect(stripFrontmatter("---\r\nname: x\r\n---\r\nbody")).toBe("body");
  });
});
