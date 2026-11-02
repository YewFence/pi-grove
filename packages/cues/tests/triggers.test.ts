import { describe, expect, it } from "vitest";

import { claimOnce, clearSession, createSessionState, dedupKey } from "../src/piCues/triggers.js";

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
