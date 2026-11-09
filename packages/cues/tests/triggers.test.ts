import { describe, expect, it } from "vitest";

import {
  claimOnce,
  clearSession,
  createSessionState,
  dedupKey,
  restoreFromEntries,
} from "../src/piCues/triggers.js";

const record = { action: "file" as const, target: "/x.md", source: "/cfg", loaded: true };

describe("claimOnce", () => {
  it("claims a key once per session", () => {
    const state = createSessionState();
    expect(claimOnce(state, dedupKey("file", "/x.md"), record)).toBeDefined();
    expect(claimOnce(state, dedupKey("file", "/x.md"), record)).toBeUndefined();
    expect(state.triggered).toHaveLength(1);
  });

  it("tracks different actions for the same identity separately", () => {
    const state = createSessionState();
    claimOnce(state, dedupKey("skill", "mise"), { ...record, action: "skill", target: "mise" });
    expect(claimOnce(state, dedupKey("file", "mise"), record)).toBeDefined();
  });
});

describe("clearSession", () => {
  it("resets dedup so cues fire again after compaction", () => {
    const state = createSessionState();
    claimOnce(state, dedupKey("file", "/x.md"), record);
    clearSession(state);
    expect(claimOnce(state, dedupKey("file", "/x.md"), record)).toBeDefined();
  });
});

const persisted = triggeredEntry({ ...record, key: dedupKey("file", "/x.md") });

function triggeredEntry(data: unknown): { type: string; customType: string; data: unknown } {
  return { type: "custom", customType: "pi-cues-triggered", data };
}

describe("restoreFromEntries", () => {
  it("rebuilds dedup and the triggered log from persisted entries", () => {
    const state = createSessionState();
    const restored = restoreFromEntries(state, [
      persisted,
      { type: "message", message: { role: "user", content: "hi" } },
      triggeredEntry({ ...record, key: dedupKey("skill", "mise") }),
    ]);
    expect(restored).toBe(2);
    expect(state.triggered).toHaveLength(2);
    expect(claimOnce(state, dedupKey("file", "/x.md"), record)).toBeUndefined();
    expect(
      claimOnce(state, dedupKey("skill", "mise"), { ...record, action: "skill" }),
    ).toBeUndefined();
  });

  it("skips foreign custom types, malformed data, and duplicate keys", () => {
    const state = createSessionState();
    const restored = restoreFromEntries(state, [
      { type: "custom", customType: "other", data: record },
      triggeredEntry(undefined),
      triggeredEntry({
        key: "file:/x.md",
        action: "nonsense",
        target: "/x",
        source: "/cfg",
        loaded: true,
      }),
      triggeredEntry({
        key: "file:/x.md",
        action: "file",
        target: "/x",
        source: "/cfg",
        loaded: false,
      }),
      triggeredEntry({
        key: "file:/x.md",
        action: "file",
        target: "/x",
        source: "/cfg",
        loaded: false,
      }),
    ]);
    expect(restored).toBe(1);
    expect(state.triggered).toHaveLength(1);
    expect(state.triggered[0]?.loaded).toBe(false);
  });
});
