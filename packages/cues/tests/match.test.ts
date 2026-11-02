import { describe, expect, it } from "vitest";

import { matchAnyValue, normalizePath } from "../src/piCues/match.js";

describe("matchAnyValue", () => {
  it("matches a command exactly when the pattern has no wildcard", () => {
    expect(matchAnyValue(["jj"], ["jj"])).toBe(true);
    expect(matchAnyValue(["jj"], ["jjq"])).toBe(false);
  });

  it("matches command globs", () => {
    expect(matchAnyValue(["mise*"], ["mise-x"])).toBe(true);
  });

  it("matches a path glob against any base", () => {
    // #given bases of /repo/src/a.test.ts #when glob src/**/*.test.ts #then projectRelative hits
    expect(matchAnyValue(["src/**/*.test.ts"], ["src/a.test.ts", "a.test.ts", "a.test.ts"])).toBe(
      true,
    );
  });

  it("matches basename patterns", () => {
    expect(matchAnyValue(["mise.toml"], ["mise.toml"])).toBe(true);
    // #given the three bases of /repo/nested/mise.toml #then the basename base hits
    expect(
      matchAnyValue(["mise.toml"], ["nested/mise.toml", "nested/mise.toml", "mise.toml"]),
    ).toBe(true);
  });

  it("supports negative patterns", () => {
    expect(matchAnyValue(["src/**", "!**/*.test.ts"], ["src/a.ts"])).toBe(true);
    expect(matchAnyValue(["src/**", "!**/*.test.ts"], ["src/a.test.ts"])).toBe(false);
  });

  it("returns false for empty patterns or values", () => {
    expect(matchAnyValue([], ["jj"])).toBe(false);
    expect(matchAnyValue(["jj"], [])).toBe(false);
  });
});

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("src\\a.ts")).toBe("src/a.ts");
  });
});
