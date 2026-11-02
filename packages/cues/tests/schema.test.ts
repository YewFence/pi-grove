import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import AjvModule from "ajv";
import { parse as parseToml } from "smol-toml";
import { createGenerator } from "ts-json-schema-generator";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const committed = JSON.parse(readFileSync(join(root, "config.schema.json"), "utf8")) as object;

describe("config.schema.json", () => {
  it("stays in sync with the RawConfig types (run `mise run schema:generate`)", () => {
    // #given the committed schema #when regenerating from types.ts #then identical
    const schema = createGenerator({
      path: join(root, "src/piCues/types.ts"),
      tsconfig: join(root, "tsconfig.json"),
      type: "RawConfig",
      skipTypeCheck: true,
    }).createSchema("RawConfig");
    expect(schema).toEqual(committed);
  });

  it("accepts a full valid config", () => {
    const validate = new AjvModule.Ajv().compile(committed);
    const toml = `
version = 1
defaults = false

[telemetry]
enabled = true

[[triggers]]
tools = ["bash"]
when.command = "jj"
action = "skill"
target = "jj-cli"

[[triggers]]
tools = ["read", "edit"]
when.path = ["src/**/*.test.ts", "!src/legacy/**"]
action = "file"
target = "./triggers/vitest.md"

[[triggers]]
tools = ["read", "edit", "write"]
action = "walkup"
target = ["AGENTS.md"]

[[triggers]]
tools = ["bash"]
when.command = "jj"
action = "inline"
target = "Commit messages in Chinese."
`;
    expect(validate(parseToml(toml))).toBe(true);
  });

  it("rejects structural errors", () => {
    const validate = new AjvModule.Ajv().compile(committed);
    const cases = [
      `version = 99`,
      `version = 1\n[[triggers]]\ntools = ["bash"]\naction = "skill"`, // missing target
      `version = 1\n[[triggers]]\ntools = ["bash"]\naction = "skill"\ntarget = "x"\nwhen.unknown = "y"`,
      `version = 1\n[[triggers]]\ntools = ["bash", "deploy"]\naction = "skill"\ntarget = "x"`,
      `version = 1\ndefaults = "no"`,
      `version = 1\ntelemetry = "off"`,
      `version = 1\n[telemetry]\nenabled = "no"`,
    ];
    for (const toml of cases) {
      expect(validate(parseToml(toml)), toml).toBe(false);
    }
  });
});
