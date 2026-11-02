import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { effectiveTrustDecision } from "../src/piCues/trust.js";

const dirs: string[] = [];

function makeHome(trust: Record<string, boolean | null> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "pi-cues-trust-home-"));
  dirs.push(home);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "trust.json"), JSON.stringify(trust));
  return home;
}

function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), "pi-cues-trust-project-"));
  dirs.push(project);
  return project;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("effectiveTrustDecision", () => {
  it("returns the exact project decision when present", () => {
    const project = makeProject();
    const home = makeHome({ [realpathSync(project)]: true });
    expect(effectiveTrustDecision(project, join(home, ".pi", "agent"))).toBe(true);
  });

  it("returns false for an explicitly declined project", () => {
    const project = makeProject();
    const home = makeHome({ [realpathSync(project)]: false });
    expect(effectiveTrustDecision(project, join(home, ".pi", "agent"))).toBe(false);
  });

  it("applies the nearest ancestor decision", () => {
    const project = makeProject();
    const home = makeHome({
      [join(realpathSync(project), "sibling")]: true,
      [realpathSync(project)]: false,
    });
    expect(effectiveTrustDecision(project, join(home, ".pi", "agent"))).toBe(false);
  });

  it("walks to a shared ancestor when the project has no entry", () => {
    const project = makeProject();
    const ancestor = realpathSync(join(project, ".."));
    const home = makeHome({ [ancestor]: true });
    expect(effectiveTrustDecision(project, join(home, ".pi", "agent"))).toBe(true);
  });

  it("returns null without any entry and fails closed on a missing file", () => {
    const project = makeProject();
    const empty = mkdtempSync(join(tmpdir(), "pi-cues-trust-empty-"));
    dirs.push(empty);
    expect(effectiveTrustDecision(project, join(makeHome(), ".pi", "agent"))).toBeNull();
    expect(effectiveTrustDecision(project, join(empty, ".pi", "agent"))).toBeNull();
  });

  it("fails closed on malformed trust.json", () => {
    const project = makeProject();
    const home = mkdtempSync(join(tmpdir(), "pi-cues-trust-home-"));
    dirs.push(home);
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "trust.json"), "not json");
    expect(effectiveTrustDecision(project, join(home, ".pi", "agent"))).toBeNull();
  });
});
