import { describe, expect, it } from "vitest";

import { languageForPath } from "../src/language.js";

describe("languageForPath", () => {
  it("maps common extensions", () => {
    expect(languageForPath("/repo/src/main.py")).toBe("Python");
    expect(languageForPath("/repo/src/App.tsx")).toBe("TypeScript");
    expect(languageForPath("/repo/cmd/server.go")).toBe("Go");
    expect(languageForPath("/repo/README.md")).toBe("Markdown");
    expect(languageForPath("/repo/.github/workflows/ci.yml")).toBe("YAML");
  });

  it("maps known extensionless basenames", () => {
    expect(languageForPath("/repo/Dockerfile")).toBe("Dockerfile");
    expect(languageForPath("/repo/go.mod")).toBe("Go");
    expect(languageForPath("/repo/Makefile")).toBe("Makefile");
  });

  it("returns undefined for unknown or extensionless files", () => {
    expect(languageForPath("/repo/data.blob")).toBeUndefined();
    expect(languageForPath("/repo/LICENSE")).toBeUndefined();
    expect(languageForPath("/repo/.gitignore")).toBeUndefined();
  });
});
