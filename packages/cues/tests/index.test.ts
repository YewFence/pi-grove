import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piCues, { execOperations, setExecOperations } from "../src/piCues/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface FakePi {
  pi: ExtensionAPI;
  handlers: Map<string, (event: any, ctx: any) => unknown>;
  sent: Array<{ message: any; options: any }>;
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  notices: string[];
  /** Same toasts as `notices`, with their level: success and failure share the target label. */
  alerts: Array<{ message: string; type: string | undefined }>;
  notify: (message: string, type?: string) => void;
}

function createFakePi(skillPaths: Record<string, string> = {}): FakePi {
  const fake: FakePi = {
    handlers: new Map(),
    sent: [],
    commands: new Map(),
    notices: [],
    alerts: [],
    notify: (message, type) => {
      fake.notices.push(message);
      fake.alerts.push({ message, type });
    },
    pi: {
      on: (event: string, handler: any) => {
        fake.handlers.set(event, handler);
        return () => {};
      },
      registerCommand: (name: string, def: any) => {
        fake.commands.set(name, def);
      },
      sendMessage: (message: any, options: any) => {
        fake.sent.push({ message, options });
      },
      getCommands: () =>
        Object.entries(skillPaths).map(([name, path]) => ({
          name: `skill:${name}`,
          description: name,
          source: "skill",
          sourceInfo: { path, source: "test", scope: "user", origin: "top-level" },
        })),
    } as unknown as ExtensionAPI,
  };
  return fake;
}

const dirs: string[] = [];
const originalHome = process.env.HOME;

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

interface Fixture {
  fake: FakePi;
  project: string;
  home: string;
  ctx: any;
}

function setup(configToml: string | null, skillPaths: Record<string, string> = {}): Fixture {
  const project = makeDir("pi-cues-it-project-");
  const home = makeDir("pi-cues-it-home-");
  if (configToml !== null) {
    writeFile(join(project, ".pi", "extensions", "pi-cues", "config.toml"), configToml);
  }
  writeFile(
    join(home, ".pi", "agent", "trust.json"),
    JSON.stringify({ [realpathSync(project)]: true }),
  );

  process.env.HOME = home;
  process.env["PI_CODING_AGENT_DIR"] = join(home, ".pi", "agent");
  const fake = createFakePi(skillPaths);
  piCues(fake.pi);

  const ctx = {
    cwd: project,
    hasUI: true,
    sessionManager: { getSessionId: () => "session-test-id" },
    ui: { notify: fake.notify },
  };
  fake.handlers.get("session_start")?.({ type: "session_start" }, ctx);
  return { fake, project, home, ctx };
}

function bashResult(command: string, isError = false): any {
  return {
    type: "tool_result",
    toolCallId: "1",
    toolName: "bash",
    input: { command },
    content: [{ type: "text", text: "output" }],
    details: undefined,
    isError,
  };
}

function editResult(filePath: string): any {
  return {
    type: "tool_result",
    toolCallId: "2",
    toolName: "edit",
    input: { path: filePath },
    content: [{ type: "text", text: "edited" }],
    details: { filePath },
    isError: false,
  };
}

function injectedText(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)
    ?.content;
  return content?.at(-1)?.text;
}

beforeEach(() => {
  process.env["PI_CODING_AGENT_DIR"] = undefined;
});

afterEach(() => {
  process.env.HOME = originalHome;
  delete process.env["PI_CODING_AGENT_DIR"];
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("global config", () => {
  it("loads global cues from a custom agent directory during session startup", async () => {
    const { fake, project, ctx } = setup(null);
    const agentDir = makeDir("pi-cues-it-agent-");
    const configDir = join(agentDir, "extensions", "pi-cues");
    writeFile(join(agentDir, "trust.json"), JSON.stringify({ [realpathSync(project)]: true }));
    writeFile(join(configDir, "note.md"), "Global agent context.");
    writeFile(
      join(configDir, "config.toml"),
      'version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "file"\ntarget = "note.md"\n',
    );
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    fake.handlers.get("session_start")?.({ type: "session_start" }, ctx);

    const result = await fake.handlers.get("tool_result")?.(bashResult("jj log"), ctx);
    expect(injectedText(result)).toContain("Global agent context.");
    expect(injectedText(result)).toContain(join(configDir, "note.md"));
    expect(fake.notices).not.toContain("pi-cues: walk-up collection disabled (no trust decision)");
  });
});

describe("skill cue", () => {
  it("injects the skill block on a matching bash command, once per session", async () => {
    // #given jj → jj-cli trigger #when `jj log` runs twice #then one injection
    const skillPath = join(makeDir("pi-cues-it-skill-"), "SKILL.md");
    writeFile(skillPath, "---\nname: jj-cli\n---\n\nJJ body.");
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "jj-cli"\n`,
      { "jj-cli": skillPath },
    );

    const handler = fake.handlers.get("tool_result");
    const first = await handler?.(bashResult("jj log"), ctx);
    expect(injectedText(first)).toContain('<skill name="jj-cli"');
    expect(injectedText(first)).toContain("JJ body.");

    const second = await handler?.(bashResult("jj log"), ctx);
    expect(second).toBeUndefined();
  });

  it("also fires for failed bash calls", async () => {
    const skillPath = join(makeDir("pi-cues-it-skill-"), "SKILL.md");
    writeFile(skillPath, "body");
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "jj-cli"\n`,
      { "jj-cli": skillPath },
    );
    expect(
      injectedText(await fake.handlers.get("tool_result")?.(bashResult("jj bad-flag", true), ctx)),
    ).toContain('<skill name="jj-cli"');
  });

  it("records a diagnostic and dedups when the skill is missing", async () => {
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "ghost"\n`,
    );
    const handler = fake.handlers.get("tool_result");
    expect(await handler?.(bashResult("jj st"), ctx)).toBeUndefined();
    expect(await handler?.(bashResult("jj log"), ctx)).toBeUndefined();

    const status = fake.commands.get("cues");
    void status?.handler("status", ctx);
    expect(fake.notices.at(-1)).toContain("Skill not found or unreadable: ghost");
    expect(fake.notices.at(-1)?.match(/Skill not found/g)).toHaveLength(1);
  });
});

describe("file cue", () => {
  it("injects a prompt file for a matching path, resolved relative to the config dir", async () => {
    const { fake, project, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["read", "edit"]\nwhen.path = "mise.toml"\naction = "file"\ntarget = "./triggers/mise.md"\n`,
    );
    writeFile(
      join(project, ".pi", "extensions", "pi-cues", "triggers", "mise.md"),
      "Mise conventions.",
    );
    writeFile(join(project, "mise.toml"), "[tools]");

    const result = await fake.handlers.get("tool_result")?.(
      editResult(join(project, "mise.toml")),
      ctx,
    );
    expect(injectedText(result)).toContain("Mise conventions.");
  });
});

describe("walkup cue", () => {
  it("fires out of the box via the builtin default", async () => {
    // #given no config file at all #when editing under a dir with AGENTS.md #then injected
    const { fake, project, ctx } = setup(null);
    writeFile(join(project, "src", "AGENTS.md"), "src rules");
    writeFile(join(project, "src", "a.ts"), "code");

    const result = await fake.handlers.get("tool_result")?.(
      editResult(join(project, "src", "a.ts")),
      ctx,
    );
    expect(injectedText(result)).toContain("src rules");
  });

  it("collects nothing without an explicit trust decision", async () => {
    const project = makeDir("pi-cues-it-project-");
    const home = makeDir("pi-cues-it-home-");
    process.env["PI_CODING_AGENT_DIR"] = join(home, ".pi", "agent");
    const fake = createFakePi();
    piCues(fake.pi);
    const ctx = {
      cwd: project,
      hasUI: true,
      sessionManager: { getSessionId: () => "session-test-id" },
      ui: { notify: fake.notify },
    };
    fake.handlers.get("session_start")?.({ type: "session_start" }, ctx);
    writeFile(join(project, "AGENTS.md"), "root agents");
    writeFile(join(project, "a.ts"), "code");

    const result = await fake.handlers.get("tool_result")?.(editResult(join(project, "a.ts")), ctx);
    expect(result).toBeUndefined();
    expect(fake.notices.some((n) => n.includes("no trust decision"))).toBe(true);
  });

  it("collects nothing when the project trust decision is false", async () => {
    const project = makeDir("pi-cues-it-project-");
    const home = makeDir("pi-cues-it-home-");
    writeFile(
      join(home, ".pi", "agent", "trust.json"),
      JSON.stringify({ [realpathSync(project)]: false }),
    );
    process.env["PI_CODING_AGENT_DIR"] = join(home, ".pi", "agent");
    const fake = createFakePi();
    piCues(fake.pi);
    const ctx = {
      cwd: project,
      hasUI: true,
      sessionManager: { getSessionId: () => "session-test-id" },
      ui: { notify: fake.notify },
    };
    fake.handlers.get("session_start")?.({ type: "session_start" }, ctx);
    writeFile(join(project, "AGENTS.md"), "root agents");
    writeFile(join(project, "a.ts"), "code");

    const result = await fake.handlers.get("tool_result")?.(editResult(join(project, "a.ts")), ctx);
    expect(result).toBeUndefined();
    expect(fake.notices.some((n) => n.includes("trust declined"))).toBe(true);
  });

  it("skips walk-up files matching exclude patterns", async () => {
    const { fake, project, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["read", "edit"]\naction = "walkup"\ntarget = ["README.md"]\nexclude = "README.md"\n`,
    );
    writeFile(join(project, "README.md"), "root readme");
    writeFile(join(project, "sub", "README.md"), "sub readme");
    writeFile(join(project, "sub", "a.ts"), "code");

    const text =
      injectedText(
        await fake.handlers.get("tool_result")?.(editResult(join(project, "sub", "a.ts")), ctx),
      ) ?? "";
    expect(text).toContain("sub readme");
    expect(text).not.toContain("root readme");
  });

  it("stays silent with defaults = false and no user walkup trigger", async () => {
    const { fake, project, ctx } = setup("version = 1\ndefaults = false\n");
    writeFile(join(project, "src", "AGENTS.md"), "src rules");
    writeFile(join(project, "src", "a.ts"), "code");

    const result = await fake.handlers.get("tool_result")?.(
      editResult(join(project, "src", "a.ts")),
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("injects each context file once across builtin and user walkup triggers", async () => {
    const { fake, project, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["edit"]\naction = "walkup"\ntarget = ["AGENTS.md", "CONTEXT.md"]\n`,
    );
    writeFile(join(project, "AGENTS.md"), "root agents");
    writeFile(join(project, "CONTEXT.md"), "root context");
    writeFile(join(project, "a.ts"), "code");

    const result = await fake.handlers.get("tool_result")?.(editResult(join(project, "a.ts")), ctx);
    const text = injectedText(result) ?? "";
    // #then AGENTS.md appears once despite matching both the default and the user trigger
    expect(text.match(/root agents/g)).toHaveLength(1);
    expect(text).toContain("root context");
  });

  it("discovers context files of directories first touched later in the session", async () => {
    const { fake, project, ctx } = setup(null);
    writeFile(join(project, "one", "AGENTS.md"), "one rules");
    writeFile(join(project, "one", "a.ts"), "code");
    writeFile(join(project, "two", "AGENTS.md"), "two rules");
    writeFile(join(project, "two", "b.ts"), "code");

    const handler = fake.handlers.get("tool_result");
    expect(injectedText(await handler?.(editResult(join(project, "one", "a.ts")), ctx))).toContain(
      "one rules",
    );
    // #then a different directory's AGENTS.md still loads later
    expect(injectedText(await handler?.(editResult(join(project, "two", "b.ts")), ctx))).toContain(
      "two rules",
    );
  });

  it("collects context files near to far and skips native ones", async () => {
    const { fake, project, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["read", "edit", "write"]\naction = "walkup"\ntarget = "AGENTS.md"\n`,
    );
    writeFile(join(project, "AGENTS.md"), "root rules");
    writeFile(join(project, "src", "AGENTS.md"), "src rules");
    writeFile(join(project, "src", "a.ts"), "code");

    // #given pi natively loaded the root AGENTS.md
    fake.handlers.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        systemPromptOptions: { contextFiles: [{ path: join(project, "AGENTS.md") }] },
      },
      ctx,
    );

    const result = await fake.handlers.get("tool_result")?.(
      editResult(join(project, "src", "a.ts")),
      ctx,
    );
    const text = injectedText(result);
    expect(text).toContain("src rules");
    expect(text).not.toContain("root rules");
  });

  it("keeps quiet when nothing is found", async () => {
    const { fake, project, ctx } = setup(
      `version = 1\ndefaults = false\n[[triggers]]\ntools = ["edit"]\naction = "walkup"\ntarget = "AGENTS.md"\n`,
    );
    writeFile(join(project, "empty", "a.ts"), "code");

    const handler = fake.handlers.get("tool_result");
    expect(await handler?.(editResult(join(project, "empty", "a.ts")), ctx)).toBeUndefined();

    writeFile(join(project, "full", "AGENTS.md"), "late rules");
    writeFile(join(project, "full", "b.ts"), "code");
    const result = await handler?.(editResult(join(project, "full", "b.ts")), ctx);
    expect(injectedText(result)).toContain("late rules");
  });
});

describe("inline cue", () => {
  it("injects the target text itself, once per session", async () => {
    // #given an inline trigger on jj #when jj runs twice #then the text is injected once
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "inline"\ntarget = "Commit messages in Chinese."\n`,
    );
    const handler = fake.handlers.get("tool_result");
    const first = await handler?.(bashResult("jj st"), ctx);
    expect(injectedText(first)).toContain("Commit messages in Chinese.");
    expect(injectedText(first)).toContain('<pi-cues action="inline" trigger="command jj"');
    expect(injectedText(first)).toContain("source=");
    expect(await handler?.(bashResult("jj log"), ctx)).toBeUndefined();
  });
});

describe("user_bash cues", () => {
  it("queues matched cues for the next turn instead of interrupting", async () => {
    const skillPath = join(makeDir("pi-cues-it-skill-"), "SKILL.md");
    writeFile(skillPath, "body");
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "jj-cli"\n`,
      { "jj-cli": skillPath },
    );

    const handler = fake.handlers.get("user_bash");
    const result = await handler?.(
      { type: "user_bash", command: "jj log", excludeFromContext: false, cwd: ctx.cwd },
      ctx,
    );
    expect(result).toBeUndefined();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.options).toEqual({ deliverAs: "nextTurn" });
    expect(fake.sent[0]?.message.content).toContain('<skill name="jj-cli"');
  });

  it("ignores !! commands excluded from context", async () => {
    const skillPath = join(makeDir("pi-cues-it-skill-"), "SKILL.md");
    writeFile(skillPath, "body");
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "jj-cli"\n`,
      { "jj-cli": skillPath },
    );
    await fake.handlers.get("user_bash")?.(
      { type: "user_bash", command: "jj log", excludeFromContext: true, cwd: ctx.cwd },
      ctx,
    );
    expect(fake.sent).toHaveLength(0);
  });
});

describe("trust and attribution", () => {
  it("ignores project config and notifies when the project is untrusted", async () => {
    const project = makeDir("pi-cues-it-project-");
    const home = makeDir("pi-cues-it-home-");
    writeFile(
      join(project, ".pi", "extensions", "pi-cues", "config.toml"),
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "jj-cli"\n`,
    );
    process.env["PI_CODING_AGENT_DIR"] = join(home, ".pi", "agent");
    const fake = createFakePi();
    piCues(fake.pi);
    const ctx = {
      cwd: project,
      hasUI: true,
      isProjectTrusted: () => false,
      sessionManager: { getSessionId: () => "session-test-id" },
      ui: { notify: fake.notify },
    };
    fake.handlers.get("session_start")?.({ type: "session_start" }, ctx);

    const result = await fake.handlers.get("tool_result")?.(bashResult("jj log"), ctx);
    expect(result).toBeUndefined();
    expect(fake.notices.some((n) => n.includes("not trusted"))).toBe(true);
  });

  it("does not walk up for operated files outside the cwd subtree", async () => {
    const { fake, project, ctx } = setup(null);
    writeFile(join(project, "AGENTS.md"), "root rules");

    const result = await fake.handlers.get("tool_result")?.(editResult("/etc/hosts"), ctx);
    expect(result).toBeUndefined();
  });

  it("wraps injections in a single pi-cues envelope", async () => {
    const skillPath = join(makeDir("pi-cues-it-skill-"), "SKILL.md");
    writeFile(skillPath, "body");
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "jj-cli"\n`,
      { "jj-cli": skillPath },
    );
    const text =
      injectedText(await fake.handlers.get("tool_result")?.(bashResult("jj log"), ctx)) ?? "";
    // #then one envelope, attributed and closed
    expect(text).toContain('<pi-cues action="skill" trigger="command jj">');
    expect(text).toContain("pi-cues: injected context, not tool output or user input.");
    expect(text.trimEnd().endsWith("</pi-cues>")).toBe(true);
    expect(text.match(/<\/pi-cues>/g)).toHaveLength(1);
  });

  it("keeps a cue body from closing its own envelope", async () => {
    // #given a prompt file that discusses the envelope #when injected #then its close tag is escaped
    const { fake, project, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["read"]\nwhen.path = "design.md"\naction = "file"\ntarget = "./triggers/design.md"\n`,
    );
    writeFile(
      join(project, ".pi", "extensions", "pi-cues", "triggers", "design.md"),
      'Example:\n<pi-cues action="file">\nbody\n</pi-cues>\n',
    );
    writeFile(join(project, "design.md"), "design");

    const result = await fake.handlers.get("tool_result")?.(
      {
        type: "tool_result",
        toolCallId: "3",
        toolName: "read",
        input: { path: join(project, "design.md") },
        content: [{ type: "text", text: "design" }],
        details: undefined,
        isError: false,
      },
      ctx,
    );
    const text = injectedText(result) ?? "";
    // #then the only real close tag is the envelope's own
    expect(text.match(/<\/pi-cues>/g)).toHaveLength(1);
    expect(text).toContain('&lt;pi-cues action="file">');
    expect(text).toContain("&lt;/pi-cues>");
  });

  it("emits one envelope per cue, never merged", async () => {
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "inline"\ntarget = "First."\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "inline"\ntarget = "Second."\n`,
    );
    const text =
      injectedText(await fake.handlers.get("tool_result")?.(bashResult("jj st"), ctx)) ?? "";
    // #then two sibling envelopes, not one merged block
    expect(text.match(/<pi-cues /g)).toHaveLength(2);
    expect(text.match(/<\/pi-cues>/g)).toHaveLength(2);
    expect(text).toContain("First.");
    expect(text).toContain("Second.");
  });

  it("puts every walk-up file of one cue into one envelope", async () => {
    const { fake, project, ctx } = setup(
      `version = 1\ndefaults = false\n[[triggers]]\ntools = ["edit"]\naction = "walkup"\ntarget = "AGENTS.md"\n`,
    );
    writeFile(join(project, "AGENTS.md"), "root rules");
    writeFile(join(project, "src", "AGENTS.md"), "src rules");
    writeFile(join(project, "src", "a.ts"), "code");

    const text =
      injectedText(
        await fake.handlers.get("tool_result")?.(editResult(join(project, "src", "a.ts")), ctx),
      ) ?? "";
    // #then one walkup envelope carrying both files
    expect(text.match(/<pi-cues action="walkup" trigger="path /g)).toHaveLength(1);
    expect(text.match(/<file path=/g)).toHaveLength(2);
  });

  it("announces pi-cues once in the system prompt", async () => {
    const { fake, ctx } = setup(null);
    const result = fake.handlers.get("before_agent_start")?.(
      { type: "before_agent_start", systemPrompt: "BASE", systemPromptOptions: {} },
      ctx,
    ) as { systemPrompt: string };
    expect(result.systemPrompt).toMatch(/^BASE/);
    expect(result.systemPrompt).toContain("pi-cues: this session has the pi-cues extension");
  });
});

describe("session lifecycle", () => {
  it("re-fires cues after compaction", async () => {
    const skillPath = join(makeDir("pi-cues-it-skill-"), "SKILL.md");
    writeFile(skillPath, "body");
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "jj-cli"\n`,
      { "jj-cli": skillPath },
    );

    const handler = fake.handlers.get("tool_result");
    await handler?.(bashResult("jj log"), ctx);
    expect(await handler?.(bashResult("jj log"), ctx)).toBeUndefined();

    fake.handlers.get("session_compact")?.({ type: "session_compact" }, ctx);
    expect(injectedText(await handler?.(bashResult("jj log"), ctx))).toContain(
      '<skill name="jj-cli"',
    );
  });

  it("notifies config diagnostics on session start", async () => {
    const { fake } = setup('version = 1\n[[triggers]]\ntools = ["bash"]\naction = "skill"\n');
    expect(fake.notices.some((n) => n.includes("pi-cues:"))).toBe(true);
  });
});

describe("telemetry", () => {
  afterEach(() => {
    delete process.env["XDG_CACHE_HOME"];
  });

  function readEvents(cache: string): Array<Record<string, unknown>> {
    return readFileSync(join(cache, "pi-cues", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("appends one event per fired cue, tagged with the pi session id", async () => {
    // #given a jj → jj-cli trigger #when `jj log` runs twice #then one event, deduped like the injection
    const cache = makeDir("pi-cues-it-cache-");
    process.env["XDG_CACHE_HOME"] = cache;
    const skillPath = join(makeDir("pi-cues-it-skill-"), "SKILL.md");
    writeFile(skillPath, "body");
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "jj-cli"\n`,
      { "jj-cli": skillPath },
    );

    const handler = fake.handlers.get("tool_result");
    await handler?.(bashResult("jj log"), ctx);
    await handler?.(bashResult("jj log"), ctx);

    const events = readEvents(cache);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: "session-test-id",
      action: "skill",
      target: "jj-cli",
      loaded: true,
    });
    expect(typeof events[0]?.["ts"]).toBe("string");
  });

  it("records failed loads as loaded: false", async () => {
    const cache = makeDir("pi-cues-it-cache-");
    process.env["XDG_CACHE_HOME"] = cache;
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "ghost"\n`,
    );

    await fake.handlers.get("tool_result")?.(bashResult("jj st"), ctx);

    expect(readEvents(cache)[0]).toMatchObject({ action: "skill", target: "ghost", loaded: false });
  });

  it("writes nothing when the global config disables telemetry", async () => {
    const cache = makeDir("pi-cues-it-cache-");
    process.env["XDG_CACHE_HOME"] = cache;
    const { fake, home, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "inline"\ntarget = "note"\n`,
    );
    writeFile(
      join(home, ".pi", "agent", "extensions", "pi-cues", "config.toml"),
      "version = 1\n[telemetry]\nenabled = false\n",
    );
    fake.handlers.get("session_start")?.({ type: "session_start" }, ctx);

    await fake.handlers.get("tool_result")?.(bashResult("jj st"), ctx);

    expect(existsSync(join(cache, "pi-cues"))).toBe(false);
  });
});

describe("when.command subcommand matching", () => {
  it("matches subcommand patterns like jj edit while bare jj still matches every call", async () => {
    // #given a subcommand-addressed trigger #when `jj edit` runs #then it fires
    const skillPath = join(makeDir("pi-cues-it-skill-"), "SKILL.md");
    writeFile(skillPath, "---\nname: jj-edit\n---\n\nJJ edit body.");
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj edit"\naction = "skill"\ntarget = "jj-edit"\n`,
      { "jj-edit": skillPath },
    );

    const handler = fake.handlers.get("tool_result");
    // #then jj edit fires
    expect(injectedText(await handler?.(bashResult("jj edit"), ctx))).toContain("JJ edit body.");
    expect(injectedText(await handler?.(bashResult("jj edit abc123"), ctx))).toBeUndefined();
    // #then jj log does not fire
    expect(await handler?.(bashResult("jj log"), ctx)).toBeUndefined();
  });

  it("bare jj matches every subcommand via prefix candidates", async () => {
    // #given jj → jj-cli trigger #when `jj edit` runs #then the bare command still fires
    const skillPath = join(makeDir("pi-cues-it-skill-"), "SKILL.md");
    writeFile(skillPath, "---\nname: jj-cli\n---\n\nJJ body.");
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "jj-cli"\n`,
      { "jj-cli": skillPath },
    );

    const handler = fake.handlers.get("tool_result");
    expect(injectedText(await handler?.(bashResult("jj edit"), ctx))).toContain("JJ body.");
    expect(injectedText(await handler?.(bashResult("jj log"), ctx))).toBeUndefined();
    expect(injectedText(await handler?.(bashResult("jj st"), ctx))).toBeUndefined();
  });

  it("does not treat flag values as subcommands", async () => {
    // #given jj edit → jj-cli trigger #when `jj log -r abc` runs #then only jj matches
    const skillPath = join(makeDir("pi-cues-it-skill-"), "SKILL.md");
    writeFile(skillPath, "---\nname: jj-cli\n---\n\nJJ body.");
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj log abc"\naction = "skill"\ntarget = "jj-cli"\n`,
      { "jj-cli": skillPath },
    );

    const handler = fake.handlers.get("tool_result");
    // -r is a flag so abc is its value, not a positional — no match
    expect(await handler?.(bashResult("jj log -r abc"), ctx)).toBeUndefined();
  });
});

describe("exec cue", () => {
  let savedOperations: typeof execOperations;

  beforeEach(() => {
    savedOperations = execOperations;
  });

  afterEach(() => {
    setExecOperations(savedOperations);
  });

  function stubOperations(
    behavior: (
      command: string,
      cwd: string,
      options: { onData: (data: Buffer) => void; timeout?: number },
    ) => Promise<{ exitCode: number | null }>,
  ): Array<{ command: string; cwd: string; timeout?: number }> {
    const calls: Array<{ command: string; cwd: string; timeout?: number }> = [];
    setExecOperations({
      exec: (command, cwd, options) => {
        calls.push({ command, cwd, timeout: options.timeout });
        return behavior(command, cwd, options);
      },
    });
    return calls;
  }

  function flush(): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  }

  it("runs the target through bash operations and appends the output to the same tool result", async () => {
    // #given jj → exec `jj edit --help` #when `jj log` runs #then the envelope rides the tool result
    const calls = stubOperations((command, _cwd, { onData }) => {
      expect(command).toBe("jj edit --help");
      onData(Buffer.from("Usage: jj edit [REVSET]\n"));
      return Promise.resolve({ exitCode: 0 });
    });
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "exec"\ntarget = "jj edit --help"\n`,
    );

    const result = await fake.handlers.get("tool_result")?.(bashResult("jj log"), ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(ctx.cwd);
    expect(calls[0]?.timeout).toBeGreaterThan(0);
    // #then nothing goes out of band: the model sees the help in this very result
    expect(fake.sent).toHaveLength(0);
    const content = injectedText(result) ?? "";
    expect(content).toContain('<pi-cues action="exec" trigger="command jj">');
    expect(content).toContain('<command-output command="jj edit --help">');
    expect(content).toContain("Usage: jj edit [REVSET]");
  });

  it("fires once per session and dedups against itself", async () => {
    const calls = stubOperations((_command, _cwd, { onData }) => {
      onData(Buffer.from("help text"));
      return Promise.resolve({ exitCode: 0 });
    });
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "exec"\ntarget = "jj edit --help"\n`,
    );

    const handler = fake.handlers.get("tool_result");
    const first = await handler?.(bashResult("jj st"), ctx);
    const second = await handler?.(bashResult("jj log"), ctx);

    expect(calls).toHaveLength(1);
    expect(injectedText(first)).toContain("help text");
    expect(second).toBeUndefined();
    expect(fake.alerts).toContainEqual({
      message: 'pi-cues: injected "jj edit --help" (exec)',
      type: "info",
    });
  });

  it("reports the outcome once the command has actually finished", async () => {
    // #given an exec cue whose command takes a while
    let settle: ((value: { exitCode: number }) => void) | undefined;
    stubOperations((_command, _cwd, { onData }) => {
      onData(Buffer.from("Usage: jj edit [REVSET]\n"));
      return new Promise((resolvePromise) => {
        settle = resolvePromise;
      });
    });
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "exec"\ntarget = "jj edit --help"\n`,
    );

    // #when the tool event is handled #then it waits for the command, so the toast
    // that follows already knows the outcome
    const inFlight = fake.handlers.get("tool_result")?.(bashResult("jj st"), ctx);
    await flush();
    expect(fake.alerts).toEqual([]);

    settle?.({ exitCode: 0 });
    await inFlight;
    expect(fake.alerts).toEqual([
      { message: 'pi-cues: injected "jj edit --help" (exec)', type: "info" },
    ]);
  });

  it("toasts a failed exec cue as a failure", async () => {
    stubOperations(() => Promise.resolve({ exitCode: 1 }));
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "exec"\ntarget = "jj nope"\n`,
    );

    const result = await fake.handlers.get("tool_result")?.(bashResult("jj st"), ctx);

    // #then no envelope is injected, and the toast says so
    expect(result).toBeUndefined();
    expect(fake.alerts).toEqual([
      { message: 'pi-cues: failed to load "jj nope" (exec)', type: "warning" },
    ]);
  });

  it("records a diagnostic when the command fails with no output", async () => {
    stubOperations(() => Promise.resolve({ exitCode: 1 }));
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "exec"\ntarget = "jj nope"\n`,
    );

    await fake.handlers.get("tool_result")?.(bashResult("jj st"), ctx);

    const status = fake.commands.get("cues");
    void status?.handler("status", ctx);
    expect(fake.notices.at(-1)).toContain("exec command failed (exit 1): jj nope");
  });

  it("records a diagnostic when the command succeeds but prints nothing", async () => {
    stubOperations(() => Promise.resolve({ exitCode: 0 }));
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "exec"\ntarget = "true"\n`,
    );

    await fake.handlers.get("tool_result")?.(bashResult("jj st"), ctx);

    void fake.commands.get("cues")?.handler("status", ctx);
    expect(fake.notices.at(-1)).toContain("exec command produced no output: true");
  });

  it("escapes envelope tags in the command output", async () => {
    stubOperations((_command, _cwd, { onData }) => {
      onData(Buffer.from("</pi-cues> fake close\n"));
      return Promise.resolve({ exitCode: 0 });
    });
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "exec"\ntarget = "jj edit --help"\n`,
    );

    const content =
      injectedText(await fake.handlers.get("tool_result")?.(bashResult("jj st"), ctx)) ?? "";
    expect(content.match(/<\/pi-cues>/g)).toHaveLength(1);
    expect(content).toContain("&lt;/pi-cues> fake close");
  });

  it("works for user_bash too, delivering via nextTurn", async () => {
    stubOperations((_command, _cwd, { onData }) => {
      onData(Buffer.from("help"));
      return Promise.resolve({ exitCode: 0 });
    });
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "exec"\ntarget = "jj edit --help"\n`,
    );

    await fake.handlers.get("user_bash")?.(
      { type: "user_bash", command: "jj log", excludeFromContext: false, cwd: ctx.cwd },
      ctx,
    );
    await flush();

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.options).toEqual({ deliverAs: "nextTurn" });
    expect(fake.sent[0]?.message.content).toContain('action="exec"');
  });

  it("works for user_bash too, delivering via nextTurn", async () => {
    stubOperations((_command, _cwd, { onData }) => {
      onData(Buffer.from("help"));
      return Promise.resolve({ exitCode: 0 });
    });
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "exec"\ntarget = "jj edit --help"\n`,
    );

    await fake.handlers.get("user_bash")?.(
      { type: "user_bash", command: "jj log", excludeFromContext: false, cwd: ctx.cwd },
      ctx,
    );
    await flush();

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.options).toEqual({ deliverAs: "nextTurn" });
    expect(fake.sent[0]?.message.content).toContain('action="exec"');
  });

  it("rejects exec triggers on path tools", async () => {
    const { fake } = setup(
      `version = 1\n[[triggers]]\ntools = ["read"]\naction = "exec"\ntarget = "echo hi"\n`,
    );
    expect(fake.notices.some((n) => n.includes("exec triggers must listen to bash only"))).toBe(
      true,
    );
  });

  it("rejects exec triggers without when.command", async () => {
    const { fake } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\naction = "exec"\ntarget = "echo hi"\n`,
    );
    expect(fake.notices.some((n) => n.includes("exec triggers require when.command"))).toBe(true);
  });
});

describe("injection notify", () => {
  it("notifies once per tool event with the injected targets", async () => {
    const skillPath = join(makeDir("pi-cues-it-skill-"), "SKILL.md");
    writeFile(skillPath, "body");
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "jj-cli"\n`,
      { "jj-cli": skillPath },
    );

    await fake.handlers.get("tool_result")?.(bashResult("jj log"), ctx);

    expect(fake.notices).toContain("pi-cues: injected jj-cli (skill)");
  });

  it("notifies failed loads as a warning", async () => {
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "ghost"\n`,
    );

    await fake.handlers.get("tool_result")?.(bashResult("jj st"), ctx);

    expect(fake.notices).toContain("pi-cues: failed to load ghost (skill)");
  });

  it("notifies for user_bash injections too", async () => {
    const skillPath = join(makeDir("pi-cues-it-skill-"), "SKILL.md");
    writeFile(skillPath, "body");
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "jj-cli"\n`,
      { "jj-cli": skillPath },
    );

    await fake.handlers.get("user_bash")?.(
      { type: "user_bash", command: "jj log", excludeFromContext: false, cwd: ctx.cwd },
      ctx,
    );

    expect(fake.notices).toContain("pi-cues: injected jj-cli (skill)");
    expect(fake.sent).toHaveLength(1);
  });

  it("stays quiet when nothing fires", async () => {
    const { fake, ctx } = setup(
      `version = 1\n[[triggers]]\ntools = ["bash"]\nwhen.command = "jj"\naction = "skill"\ntarget = "jj-cli"\n`,
    );

    await fake.handlers.get("tool_result")?.(bashResult("ls -la"), ctx);

    expect(fake.notices.some((n) => n.startsWith("pi-cues: injected"))).toBe(false);
    expect(fake.notices.some((n) => n.startsWith("pi-cues: failed"))).toBe(false);
  });
});
