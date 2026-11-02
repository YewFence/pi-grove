import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/piCues/config.js";
import { resolveAgentDir } from "../src/piCues/trust.js";

const dirs: string[] = [];

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pi-cues-config-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

/** An empty agent directory. */
function makeAgentDir(): string {
  return join(makeTree({}), ".pi", "agent");
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const VALID = `
version = 1

[[triggers]]
tools = ["bash"]
when.command = "jj"
action = "skill"
target = "jj-cli"

[[triggers]]
tools = ["read", "edit"]
when.path = "src/**"
action = "walkup"
target = ["AGENTS.md"]
`;

describe("loadConfig", () => {
  it("loads global config from the default agent directory", () => {
    const home = makeTree({
      ".pi/agent/extensions/pi-cues/config.toml": VALID,
      ".pi/extensions/pi-cues/config.toml": "version = 99\n",
    });
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const config = loadConfig({ cwd: makeTree({}), agentDir: resolveAgentDir() });
    expect(config.files).toEqual([join(home, ".pi/agent/extensions/pi-cues/config.toml")]);
    expect(config.triggers).toHaveLength(3);
    expect(config.diagnostics).toEqual([]);
  });

  it("loads global config from PI_CODING_AGENT_DIR instead of the home directory", () => {
    const home = makeTree({ ".pi/agent/extensions/pi-cues/config.toml": "version = 99\n" });
    const agentDir = makeTree({ "extensions/pi-cues/config.toml": VALID });
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const config = loadConfig({ cwd: makeTree({}), agentDir: resolveAgentDir() });
    expect(config.files).toEqual([join(agentDir, "extensions/pi-cues/config.toml")]);
    expect(config.triggers).toHaveLength(3);
    expect(config.diagnostics).toEqual([]);
  });

  it("loads and merges global then project config", () => {
    // #given valid config at both levels #when loading #then triggers append, global first
    const home = makeTree({ ".pi/agent/extensions/pi-cues/config.toml": VALID });
    const project = makeTree({ ".pi/extensions/pi-cues/config.toml": VALID });
    const config = loadConfig({ cwd: project, agentDir: join(home, ".pi", "agent") });
    expect(config.files).toEqual([
      join(home, ".pi/agent/extensions/pi-cues/config.toml"),
      join(project, ".pi/extensions/pi-cues/config.toml"),
    ]);
    expect(config.triggers).toHaveLength(5); // 2 global + 2 project + builtin default
    expect(config.triggers[0]?.source).toBe("<builtin defaults>");
    expect(config.diagnostics).toEqual([]);
  });

  it("ignores the legacy .pi/pi-cues.toml location", () => {
    const project = makeTree({ ".pi/pi-cues.toml": VALID });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir() });
    expect(config.files).toEqual([]);
    expect(config.diagnostics).toEqual([]);
  });

  it("ignores the legacy global pi-cues.toml location", () => {
    const home = makeTree({ ".pi/agent/pi-cues.toml": VALID });
    const config = loadConfig({ cwd: makeTree({}), agentDir: join(home, ".pi", "agent") });
    expect(config.files).toEqual([]);
    expect(config.diagnostics).toEqual([]);
  });

  it("ships a builtin walkup default when no config exists", () => {
    const config = loadConfig({ cwd: makeTree({}), agentDir: makeAgentDir() });
    expect(config.triggers).toHaveLength(1);
    expect(config.triggers[0]).toMatchObject({
      action: "walkup",
      targets: ["AGENTS.md"],
      tools: ["read", "edit", "write"],
    });
    expect(config.triggers[0]?.when).toBeUndefined();
  });

  it("disables builtin defaults with `defaults = false` in either level", () => {
    const home = makeTree({
      ".pi/agent/extensions/pi-cues/config.toml": "version = 1\ndefaults = false\n",
    });
    const project = makeTree({ ".pi/extensions/pi-cues/config.toml": VALID });
    const config = loadConfig({ cwd: project, agentDir: join(home, ".pi", "agent") });
    expect(config.triggers).toHaveLength(2);
    expect(config.triggers.every((t) => t.source !== "<builtin defaults>")).toBe(true);
  });

  it("loads project config from .pi/extensions/pi-cues/config.toml", () => {
    const project = makeTree({ ".pi/extensions/pi-cues/config.toml": VALID });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir() });
    expect(config.files).toEqual([join(project, ".pi/extensions/pi-cues/config.toml")]);
    expect(config.triggers).toHaveLength(3); // builtin default + 2 configured
  });

  it("tolerates missing config files", () => {
    const config = loadConfig({ cwd: makeTree({}), agentDir: makeAgentDir() });
    expect(config.files).toEqual([]);
    expect(config.diagnostics).toEqual([]);
  });

  it("diagnoses invalid TOML and continues with other files", () => {
    const home = makeTree({ ".pi/agent/extensions/pi-cues/config.toml": "not [valid" });
    const project = makeTree({ ".pi/extensions/pi-cues/config.toml": VALID });
    const config = loadConfig({ cwd: project, agentDir: join(home, ".pi", "agent") });
    expect(config.diagnostics).toHaveLength(1);
    expect(config.diagnostics[0]?.severity).toBe("error");
    expect(config.triggers).toHaveLength(3); // builtin default + 2 from project
  });

  it("rejects a wrong version for the whole file", () => {
    const project = makeTree({ ".pi/extensions/pi-cues/config.toml": "version = 99\n" });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir() });
    expect(config.triggers.map((t) => t.action)).toEqual(["walkup"]);
    expect(config.diagnostics[0]?.message).toContain("version");
  });

  it("skips entries whose when key does not fit tools", () => {
    const project = makeTree({
      ".pi/extensions/pi-cues/config.toml": `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.path = "x"\naction = "file"\ntarget = "a.md"\n`,
    });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir() });
    expect(config.triggers.map((t) => t.source)).toEqual(["<builtin defaults>"]);
    expect(config.diagnostics[0]?.severity).toBe("warning");
  });

  it("rejects skill/file triggers without when but allows walkup", () => {
    const project = makeTree({
      ".pi/extensions/pi-cues/config.toml": `version = 1
[[triggers]]
tools = ["bash"]
action = "skill"
target = "jj-cli"

[[triggers]]
tools = ["read"]
action = "walkup"
target = "AGENTS.md"
`,
    });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir() });
    expect(config.triggers).toHaveLength(2);
    expect(config.triggers[1]?.action).toBe("walkup");
    expect(config.triggers[1]?.when).toBeUndefined();
  });

  it("rejects walkup triggers listening to bash", () => {
    const project = makeTree({
      ".pi/extensions/pi-cues/config.toml": `version = 1\n[[triggers]]\ntools = ["bash"]\naction = "walkup"\ntarget = "AGENTS.md"\n`,
    });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir() });
    expect(config.triggers.map((t) => t.source)).toEqual(["<builtin defaults>"]);
  });

  it("parses exclude patterns on walkup triggers", () => {
    const project = makeTree({
      ".pi/extensions/pi-cues/config.toml": `version = 1\n[[triggers]]\ntools = ["read"]\naction = "walkup"\ntarget = "AGENTS.md"\nexclude = ["README.md", "**/NOTES.md"]\n`,
    });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir() });
    expect(config.triggers[1]?.excludes).toEqual(["README.md", "**/NOTES.md"]);
  });

  it("defaults walkup excludes to an empty list and rejects exclude on other actions", () => {
    const project = makeTree({
      ".pi/extensions/pi-cues/config.toml": `version = 1
[[triggers]]
tools = ["read"]
action = "walkup"
target = "AGENTS.md"

[[triggers]]
tools = ["bash"]
when.command = "jj"
action = "skill"
target = "jj-cli"
exclude = "x.md"
`,
    });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir() });
    expect(config.triggers[1]?.excludes).toEqual([]);
    expect(config.diagnostics.some((d) => d.message.includes("only valid on walkup"))).toBe(true);
  });

  it("rejects exclude patterns with a '!' prefix", () => {
    const project = makeTree({
      ".pi/extensions/pi-cues/config.toml": `version = 1\n[[triggers]]\ntools = ["read"]\naction = "walkup"\ntarget = "AGENTS.md"\nexclude = "!README.md"\n`,
    });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir() });
    expect(config.diagnostics.some((d) => d.message.includes("'!'"))).toBe(true);
  });

  it("rejects project file targets escaping the config directory", () => {
    // #given a project config pointing outside itself #when loading #then the entry is rejected
    const project = makeTree({
      ".pi/extensions/pi-cues/config.toml": `version = 1\n[[triggers]]\ntools = ["read"]\nwhen.path = "x"\naction = "file"\ntarget = "../../outside.md"\n`,
    });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir() });
    expect(config.triggers.map((t) => t.source)).toEqual(["<builtin defaults>"]);
    expect(config.diagnostics.some((d) => d.message.includes("escapes"))).toBe(true);
  });

  it("allows absolute file targets in global config", () => {
    const home = makeTree({
      ".pi/agent/extensions/pi-cues/config.toml": `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "file"\ntarget = "/shared/jj.md"\n`,
    });
    const config = loadConfig({ cwd: makeTree({}), agentDir: join(home, ".pi", "agent") });
    expect(config.triggers.some((t) => t.targets[0] === "/shared/jj.md")).toBe(true);
  });

  it("ignores project config when the project is untrusted", () => {
    const project = makeTree({ ".pi/extensions/pi-cues/config.toml": VALID });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir(), projectTrusted: false });
    expect(config.triggers.map((t) => t.source)).toEqual(["<builtin defaults>"]);
    expect(config.projectUntrusted).toBe(true);
    expect(config.diagnostics.some((d) => d.message.includes("not trusted"))).toBe(true);
  });

  it("normalizes target to a list and records the config dir", () => {
    const project = makeTree({ ".pi/extensions/pi-cues/config.toml": VALID });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir() });
    expect(config.triggers[1]?.targets).toEqual(["jj-cli"]);
    expect(config.triggers[1]?.configDir).toBe(join(project, ".pi", "extensions", "pi-cues"));
  });
});

describe("telemetry setting", () => {
  it("defaults to enabled", () => {
    const home = makeTree({ ".pi/agent/extensions/pi-cues/config.toml": VALID });
    const config = loadConfig({ cwd: makeTree({}), agentDir: join(home, ".pi", "agent") });
    expect(config.telemetry).toBe(true);
    expect(config.diagnostics).toEqual([]);
  });

  it("turns off via [telemetry] enabled = false in the global config", () => {
    const home = makeTree({
      ".pi/agent/extensions/pi-cues/config.toml": "version = 1\n[telemetry]\nenabled = false\n",
    });
    const config = loadConfig({ cwd: makeTree({}), agentDir: join(home, ".pi", "agent") });
    expect(config.telemetry).toBe(false);
    expect(config.diagnostics).toEqual([]);
  });

  it("ignores project-level telemetry with a warning", () => {
    const project = makeTree({
      ".pi/extensions/pi-cues/config.toml": "version = 1\n[telemetry]\nenabled = false\n",
    });
    const config = loadConfig({ cwd: project, agentDir: makeAgentDir() });
    expect(config.telemetry).toBe(true);
    expect(
      config.diagnostics.some((d) => d.message.includes("only valid in the global config")),
    ).toBe(true);
  });

  it("diagnoses malformed telemetry entries and stays enabled", () => {
    const home = makeTree({
      ".pi/agent/extensions/pi-cues/config.toml": 'version = 1\ntelemetry = "off"\n',
    });
    const enabledString = makeTree({
      ".pi/agent/extensions/pi-cues/config.toml": 'version = 1\n[telemetry]\nenabled = "no"\n',
    });
    const unknownKey = makeTree({
      ".pi/agent/extensions/pi-cues/config.toml": "version = 1\n[telemetry]\nremote = true\n",
    });
    for (const tree of [home, enabledString, unknownKey]) {
      const config = loadConfig({ cwd: makeTree({}), agentDir: join(tree, ".pi", "agent") });
      expect(config.telemetry).toBe(true);
      expect(config.diagnostics.some((d) => d.message.includes("telemetry"))).toBe(true);
    }
  });
});
