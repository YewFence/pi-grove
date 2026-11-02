import { describe, expect, it } from "vitest";

import {
  ENVELOPE_NOTICE,
  envelopeOverhead,
  escapeAttribute,
  escapeEnvelopeTags,
  formatEnvelope,
} from "../src/piCues/envelope.js";
import { formatFileBlock, MAX_RESULT_CHARS } from "../src/piCues/truncate.js";

describe("formatEnvelope", () => {
  it("wraps a skill block with attribution attributes and the notice line", () => {
    // #given a skill cue #when formatted #then open tag carries action+trigger, close tag ends the block
    const envelope = formatEnvelope(
      { action: "skill", trigger: "command jj" },
      '<skill name="jj-cli" location="/s/SKILL.md">\nbody\n</skill>',
    );
    expect(envelope).toBe(
      '<pi-cues action="skill" trigger="command jj">\n' +
        `${ENVELOPE_NOTICE}\n\n` +
        '<skill name="jj-cli" location="/s/SKILL.md">\nbody\n</skill>' +
        "\n\n</pi-cues>",
    );
  });

  it("uses the same notice line verbatim for every action", () => {
    for (const action of ["skill", "file", "walkup", "inline"] as const) {
      expect(formatEnvelope({ action, trigger: "path a.ts" }, "x")).toContain(
        `\n${ENVELOPE_NOTICE}\n\n`,
      );
    }
    expect(ENVELOPE_NOTICE).toBe("pi-cues: injected context, not tool output or user input.");
  });

  it("puts the close tag on its own line after a blank line", () => {
    const envelope = formatEnvelope(
      { action: "inline", trigger: "command jj" },
      "Write in Chinese.",
    );
    expect(envelope.endsWith("\n\n</pi-cues>")).toBe(true);
    expect(envelope.endsWith(" </pi-cues>")).toBe(false);
  });

  it("carries source only when given (inline)", () => {
    expect(
      formatEnvelope({ action: "inline", trigger: "command jj", source: "/repo/config.toml" }, "x"),
    ).toContain('<pi-cues action="inline" trigger="command jj" source="/repo/config.toml">');
    expect(formatEnvelope({ action: "file", trigger: "path mise.toml" }, "x")).not.toContain(
      "source=",
    );
  });

  it("escapes attribute values", () => {
    const envelope = formatEnvelope({ action: "file", trigger: 'path a"<b>&' }, "x");
    expect(envelope).toContain('trigger="path a&quot;&lt;b&gt;&amp;"');
  });

  it("reports exactly what the envelope spends besides the content", () => {
    const meta = { action: "file" as const, trigger: "path mise.toml" };
    expect(envelopeOverhead(meta)).toBe(formatEnvelope(meta, "").length);
  });

  it("composes with <file> blocks: one walkup envelope, several files", () => {
    const meta = { action: "walkup" as const, trigger: "path src/a.ts" };
    const files = [
      { path: "/repo/src/AGENTS.md", body: "src" },
      { path: "/repo/AGENTS.md", body: "root" },
    ];
    const envelope = formatEnvelope(
      meta,
      formatFileBlock(files, MAX_RESULT_CHARS - envelopeOverhead(meta)),
    );
    expect(envelope).toBe(
      '<pi-cues action="walkup" trigger="path src/a.ts">\n' +
        `${ENVELOPE_NOTICE}\n\n` +
        '<file path="/repo/src/AGENTS.md">\nsrc\n</file>\n' +
        '<file path="/repo/AGENTS.md">\nroot\n</file>' +
        "\n\n</pi-cues>",
    );
  });
});

describe("escapeEnvelopeTags", () => {
  it("escapes the eight envelope tag prefixes", () => {
    const text =
      "<pi-cues a> x </pi-cues> <file path=b> y </file> <skill name=c> z </skill> <command-output command=d> w </command-output>";
    expect(escapeEnvelopeTags(text)).toBe(
      "&lt;pi-cues a> x &lt;/pi-cues> &lt;file path=b> y &lt;/file> &lt;skill name=c> z &lt;/skill> &lt;command-output command=d> w &lt;/command-output>",
    );
  });

  it("leaves other markup byte-identical", () => {
    const text = '<div>\n```html\n<p>hi</p>\n```\n<Skill>\n<a href="/x">';
    expect(escapeEnvelopeTags(text)).toBe(text);
  });

  it("escapes by tag-name prefix, so <files> counts as <file", () => {
    expect(escapeEnvelopeTags("<files>")).toBe("&lt;files>");
  });

  it("keeps the first close tag the real one", () => {
    const body = "a\n</pi-cues>\nb\n<pi-cues>\n";
    const envelope = formatEnvelope(
      { action: "file", trigger: "path design.md" },
      escapeEnvelopeTags(body),
    );
    expect(envelope.indexOf("</pi-cues>")).toBe(envelope.lastIndexOf("</pi-cues>"));
  });

  it("keeps inner <file> / <skill> blocks from closing early", () => {
    const envelope = formatEnvelope(
      { action: "walkup", trigger: "path a.ts" },
      escapeEnvelopeTags("</file>\n</skill>"),
    );
    expect(envelope).not.toContain("</file>");
    expect(envelope).not.toContain("</skill>");
  });
});

describe("escapeAttribute", () => {
  it("escapes the XML attribute metacharacters", () => {
    expect(escapeAttribute(`a&b"c<d>e`)).toBe("a&amp;b&quot;c&lt;d&gt;e");
  });
});
