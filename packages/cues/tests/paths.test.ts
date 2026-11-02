import { describe, expect, it } from "vitest";

import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

import { extractToolPaths, pathBaseValues, toPathBases } from "../src/piCues/paths.js";

function toolEvent(
  toolName: string,
  input: Record<string, unknown>,
  details?: unknown,
): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "t1",
    toolName,
    input,
    content: [],
    details,
    isError: false,
  } as unknown as ToolResultEvent;
}

describe("extractToolPaths", () => {
  it("reads details.filePath and input.path for read/edit", () => {
    const event = toolEvent("read", { path: "/repo/a.ts" }, { filePath: "/repo/a.ts" });
    expect(extractToolPaths(event, "/repo")).toEqual(["/repo/a.ts"]);
  });

  it("reads input.filePath and input.path for write", () => {
    const event = toolEvent("write", { filePath: "/repo/new.ts", path: "/repo/new.ts" });
    expect(extractToolPaths(event, "/repo")).toEqual(["/repo/new.ts"]);
  });

  it("resolves relative paths against cwd", () => {
    const event = toolEvent("read", { path: "src/a.ts" });
    expect(extractToolPaths(event, "/repo")).toEqual(["/repo/src/a.ts"]);
  });

  it("ignores failed tool calls", () => {
    const event = { ...toolEvent("read", { path: "/repo/a.ts" }), isError: true };
    expect(extractToolPaths(event, "/repo")).toEqual([]);
  });

  it("ignores non-path tools", () => {
    const event = toolEvent("bash", { command: "ls" });
    expect(extractToolPaths(event, "/repo")).toEqual([]);
  });
});

describe("toPathBases", () => {
  it("produces project / scope / basename bases, POSIX-normalized", () => {
    const bases = toPathBases("/repo/src/a.ts", "/repo", "/repo/.pi");
    expect(pathBaseValues(bases)).toEqual(["src/a.ts", "../src/a.ts", "a.ts"]);
  });
});
