import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  recordTriggeredEvent,
  resolveCacheDir,
  telemetryEventFile,
  type TelemetryEvent,
} from "../src/piCues/telemetry.js";

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function record(): Parameters<typeof recordTriggeredEvent>[2] {
  return { action: "skill", target: "jj-cli", source: "<builtin defaults>", loaded: true };
}

function readEvents(cacheDir: string): TelemetryEvent[] {
  return readFileSync(telemetryEventFile(cacheDir), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TelemetryEvent);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveCacheDir", () => {
  it("prefers XDG_CACHE_HOME and falls back to ~/.cache", () => {
    const previous = process.env["XDG_CACHE_HOME"];
    const xdg = makeDir("pi-cues-telemetry-xdg-");
    try {
      process.env["XDG_CACHE_HOME"] = xdg;
      expect(resolveCacheDir()).toBe(join(xdg, "pi-cues"));
      process.env["XDG_CACHE_HOME"] = "";
      expect(resolveCacheDir()).toBe(join(homedir(), ".cache", "pi-cues"));
    } finally {
      if (previous === undefined) {
        delete process.env["XDG_CACHE_HOME"];
      } else {
        process.env["XDG_CACHE_HOME"] = previous;
      }
    }
  });
});

describe("recordTriggeredEvent", () => {
  it("appends one JSON line per call with the full event shape", () => {
    const cacheDir = makeDir("pi-cues-telemetry-");

    recordTriggeredEvent(cacheDir, "session-1", record());
    recordTriggeredEvent(cacheDir, "session-1", { ...record(), loaded: false });

    const events = readEvents(cacheDir);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      sessionId: "session-1",
      action: "skill",
      target: "jj-cli",
      source: "<builtin defaults>",
      loaded: true,
    });
    expect(events[1]?.loaded).toBe(false);
    expect(events[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("rotates the event file to .1 once it grows past the size cap", () => {
    const cacheDir = makeDir("pi-cues-telemetry-");
    const file = telemetryEventFile(cacheDir);
    writeFileSync(file, "x".repeat(2 * 1024 * 1024 + 1));

    recordTriggeredEvent(cacheDir, "session-1", record());

    expect(readEvents(cacheDir)).toHaveLength(1);
    expect(statSync(`${file}.1`).size).toBe(2 * 1024 * 1024 + 1);
  });

  it("swallows failures instead of throwing", () => {
    const notADir = join(makeDir("pi-cues-telemetry-"), "occupied");
    writeFileSync(notADir, "file where the cache dir should be");

    expect(() => recordTriggeredEvent(notADir, "session-1", record())).not.toThrow();
    expect(existsSync(notADir)).toBe(true);
  });
});
