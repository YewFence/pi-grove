import { describe, expect, it } from "vitest";

import { extractCommands } from "../src/piCues/parse.js";

describe("extractCommands", () => {
  it("extracts a bare command as a single candidate", () => {
    expect(extractCommands("jj")).toEqual(["jj"]);
  });

  it('emits every word-level prefix, so "jj" still matches a subcommand call', () => {
    // #given `jj edit abc123` #when extracting #then the bare command and
    // subcommand prefixes are both candidates
    expect(extractCommands("jj edit abc123")).toEqual(["jj", "jj edit", "jj edit abc123"]);
  });

  it("stops the word run at the first flag", () => {
    // -r is a flag, so its value never joins the match candidates
    expect(extractCommands("jj log -r abc")).toEqual(["jj", "jj log"]);
  });

  it("treats a bare subcommand as one word, not as separate candidates", () => {
    expect(extractCommands("jj edit")).toEqual(["jj", "jj edit"]);
  });

  it("extracts both sides of a pipe", () => {
    expect(extractCommands("jj log | rg foo")).toEqual(["jj", "jj log", "rg", "rg foo"]);
  });

  it("splits on && and ;", () => {
    expect(extractCommands("jj log && rg foo; ls")).toEqual(["jj", "jj log", "rg", "rg foo", "ls"]);
  });

  it("strips environment assignment prefixes", () => {
    expect(extractCommands("FOO=1 BAR=2 jj log")).toEqual(["jj", "jj log"]);
  });

  it("ignores a bare assignment", () => {
    expect(extractCommands("FOO=1")).toEqual([]);
  });

  it("strips single-word wrappers", () => {
    expect(extractCommands("sudo jj log")).toEqual(["jj", "jj log"]);
    expect(extractCommands("npx -y some-cli --flag")).toEqual(["some-cli"]);
  });

  it("strips two-word wrappers", () => {
    expect(extractCommands("uv run pytest")).toEqual(["pytest"]);
  });

  it("strips mise x with a -- separator", () => {
    expect(extractCommands("mise x -- jj log")).toEqual(["jj", "jj log"]);
  });

  it("does not treat redirection targets as commands", () => {
    expect(extractCommands("jj log > out.txt 2>&1")).toEqual(["jj", "jj log"]);
  });

  it("skips command substitution contents", () => {
    expect(extractCommands("echo $(jj st)")).toEqual(["echo"]);
    expect(extractCommands("VAR=$(echo hi) jj log")).toEqual(["jj", "jj log"]);
  });

  it("returns the basename of a path-qualified command", () => {
    expect(extractCommands("./node_modules/.bin/vitest run")).toEqual(["vitest", "vitest run"]);
  });

  it("deduplicates shared prefixes across repeated commands", () => {
    expect(extractCommands("jj st; jj log")).toEqual(["jj", "jj st", "jj log"]);
  });

  it("returns no command for unbalanced quotes instead of throwing", () => {
    expect(() => extractCommands("'unclosed")).not.toThrow();
  });
});
