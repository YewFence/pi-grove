import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEditToolDefinition,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { createEditDiagnosticsToolDefinition } from "../src/index.ts";

function createTool(content: string, createDefinition = createEditDiagnosticsToolDefinition) {
  let written: string | undefined;
  let writes = 0;
  const tool = createDefinition("/workspace", {
    operations: {
      access: async () => {},
      readFile: async () => Buffer.from(content),
      writeFile: async (_path, nextContent) => {
        writes++;
        written = nextContent;
      },
    },
  });
  return { tool, getWritten: () => written, getWrites: () => writes };
}

const context = (cwd = "/workspace") => ({ cwd }) as ExtensionToolContext;

test("explains a unique whitespace-only candidate without writing", async () => {
  const { tool, getWritten } = createTool("\t\tvalue: number;\nnext();\n");

  await assert.rejects(
    tool.execute(
      "call-1",
      {
        path: "example.ts",
        edits: [{ oldText: "        value: number;", newText: "        value: string;" }],
      },
      undefined,
      undefined,
      context(),
    ),
    (error: Error) => {
      assert.match(error.message, /^Could not find the exact text\.$/m);
      assert.match(error.message, /A unique candidate differs only in whitespace at lines 1-1\./);
      assert.ok(error.message.includes('Your input (oldText): "        value: number;"'));
      assert.ok(error.message.includes('File content:         "\\t\\tvalue: number;"'));
      assert.match(error.message, /No changes were written\./);
      return true;
    },
  );
  assert.equal(getWritten(), undefined);
});

test("reports the failing edit index in a multi-edit call", async () => {
  const { tool, getWritten } = createTool("first();\n\tsecond();\n");

  await assert.rejects(
    tool.execute(
      "call-2",
      {
        path: "example.ts",
        edits: [
          { oldText: "first();", newText: "one();" },
          { oldText: "    second();", newText: "    two();" },
        ],
      },
      undefined,
      undefined,
      context(),
    ),
    (error: Error) => {
      assert.match(error.message, /^Could not find edits\[1\]\.$/m);
      assert.match(error.message, /A unique candidate differs only in whitespace at lines 2-2\./);
      assert.doesNotMatch(error.message, /Retry the complete edits array/);
      return true;
    },
  );
  assert.equal(getWritten(), undefined);
});

test("keeps the native failure when no whitespace-only candidate exists", async () => {
  const { tool } = createTool("first();\n");

  await assert.rejects(
    tool.execute(
      "call-3",
      {
        path: "example.ts",
        edits: [{ oldText: "missing();", newText: "found();" }],
      },
      undefined,
      undefined,
      context(),
    ),
    (error: Error) => {
      assert.match(error.message, /No exact or supported fuzzy match was found\./);
      assert.match(error.message, /Re-read the file and copy the source text exactly/);
      assert.match(error.message, /No changes were written\./);
      return true;
    },
  );
});

test("does not guess when whitespace-only text has multiple candidates", async () => {
  const { tool } = createTool("\titem();\n  item();\n");

  await assert.rejects(
    tool.execute(
      "call-4",
      {
        path: "example.ts",
        edits: [{ oldText: "    item();", newText: "    changed();" }],
      },
      undefined,
      undefined,
      context(),
    ),
    (error: Error) => {
      assert.doesNotMatch(error.message, /A unique candidate/);
      assert.match(error.message, /No exact or supported fuzzy match was found\./);
      return true;
    },
  );
});

test("preserves native success details and writes once", async () => {
  const { tool, getWritten, getWrites } = createTool("first();\n");

  const result = await tool.execute(
    "call-5",
    {
      path: "example.ts",
      edits: [{ oldText: "first();", newText: "changed();" }],
    },
    undefined,
    undefined,
    context(),
  );

  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, "Successfully replaced 1 block(s) in example.ts.");
  assert.equal(getWritten(), "changed();\n");
  assert.equal(getWrites(), 1);
  assert.equal(typeof result.details?.patch, "string");
});

test("returns complete multiline candidates without truncation or another read request", async () => {
  const codeLines = Array.from({ length: 30 }, (_value, index) => `call${index}();`);
  const content = `before();\n${codeLines.map((line) => `\t${line}\n`).join("")}after();\n`;
  const oldText = codeLines.map((line) => `    ${line}\n`).join("");
  const foundText = codeLines.map((line) => `\t${line}\n`).join("");
  const { tool, getWrites } = createTool(content);

  await assert.rejects(
    tool.execute(
      "multiline",
      { path: "example.ts", edits: [{ oldText, newText: "replacement();\n" }] },
      undefined,
      undefined,
      context(),
    ),
    (error: Error) => {
      assert.match(error.message, /at lines 2-31\./);
      assert.ok(error.message.includes(`Your input (oldText): ${JSON.stringify(oldText)}`));
      assert.ok(error.message.includes(`File content:         ${JSON.stringify(foundText)}`));
      assert.doesNotMatch(error.message, /omitted|excerpt|Read the candidate/);
      return true;
    },
  );
  assert.equal(getWrites(), 0);
});

test("locates line alignment and blank-line differences", async () => {
  for (const { content, oldText, foundText, range } of [
    {
      content: "before();\n\tField string     `tag`\n",
      oldText: "\tField string `tag`\n",
      foundText: "\tField string     `tag`\n",
      range: "2-2",
    },
    {
      content: "before();\nfirst();\n\nlast();\n",
      oldText: "first();\nlast();\n",
      foundText: "first();\n\nlast();\n",
      range: "2-4",
    },
    {
      content: "\uFEFFbefore();\r\n\tvalue();\r\n",
      oldText: "    value();\n",
      foundText: "\tvalue();\n",
      range: "2-2",
    },
  ]) {
    const { tool, getWrites } = createTool(content);
    await assert.rejects(
      tool.execute(
        "layout",
        { path: "example.ts", edits: [{ oldText, newText: "replacement" }] },
        undefined,
        undefined,
        context(),
      ),
      (error: Error) => {
        assert.ok(error.message.includes(`at lines ${range}.`));
        assert.ok(error.message.includes(`File content:         ${JSON.stringify(foundText)}`));
        return true;
      },
    );
    assert.equal(getWrites(), 0);
  }
});

test("retains native errors for duplicates, overlaps, empty patterns and identical replacements", async () => {
  for (const { content, edits } of [
    { content: "item();\nitem();\n", edits: [{ oldText: "item();", newText: "next();" }] },
    {
      content: "abcd\n",
      edits: [
        { oldText: "abc", newText: "A" },
        { oldText: "bcd", newText: "B" },
      ],
    },
    { content: "item();\n", edits: [{ oldText: "", newText: "next();" }] },
    { content: "item();\n", edits: [{ oldText: "item();", newText: "item();" }] },
  ]) {
    const native = createTool(content, createEditToolDefinition);
    const enhanced = createTool(content);
    const input = { path: "example.ts", edits };
    const nativeError = await native.tool
      .execute("native-error", input, undefined, undefined, context())
      .catch((error: Error) => error);
    assert.ok(nativeError instanceof Error);
    await assert.rejects(
      enhanced.tool.execute("enhanced-error", input, undefined, undefined, context()),
      {
        message: nativeError.message,
      },
    );
    assert.equal(enhanced.getWrites(), 0);
  }
});

test("preserves native fuzzy matching, BOM, line endings and result details", async () => {
  const content = "\uFEFFalpha   \r\nbeta\r\n";
  const input = { path: "example.ts", edits: [{ oldText: "alpha\n", newText: "ALPHA\n" }] };
  const native = createTool(content, createEditToolDefinition);
  const enhanced = createTool(content);
  assert.deepEqual(
    await enhanced.tool.execute("enhanced", input, undefined, undefined, context()),
    await native.tool.execute("native", input, undefined, undefined, context()),
  );
  assert.equal(enhanced.getWritten(), "\uFEFFALPHA\r\nbeta\r\n");
  assert.equal(enhanced.getWritten(), native.getWritten());
  assert.equal(enhanced.getWrites(), 1);
});

test("keeps each concurrent call's own read snapshot", async () => {
  const tool = createEditDiagnosticsToolDefinition("/workspace", {
    operations: {
      access: async () => {},
      readFile: async (path) => {
        if (path.endsWith("first.ts")) await new Promise((resolve) => setTimeout(resolve, 20));
        return Buffer.from(path.endsWith("first.ts") ? "\tfirst();\n" : "\tsecond();\n");
      },
      writeFile: async () => {
        assert.fail("failed edits must not write");
      },
    },
  });
  const errors = await Promise.all(
    ["first", "second"].map(async (name) => {
      const result = await tool
        .execute(
          name,
          { path: `${name}.ts`, edits: [{ oldText: `    ${name}();`, newText: "next();" }] },
          undefined,
          undefined,
          context(),
        )
        .catch((error: unknown) => error);
      assert.ok(result instanceof Error);
      return result.message;
    }),
  );
  assert.ok(errors[0].includes('File content:         "\\tfirst();"'));
  assert.ok(errors[1].includes('File content:         "\\tsecond();"'));
});

test("does not reclassify write failures or cancellation as matching failures", async () => {
  const writeError = new Error("disk full");
  const operations = {
    access: async () => {},
    readFile: async () => Buffer.from("item();\n"),
    writeFile: async () => {
      throw writeError;
    },
  };
  const tool = createEditDiagnosticsToolDefinition("/workspace", { operations });
  const input = { path: "example.ts", edits: [{ oldText: "item();", newText: "next();" }] };
  await assert.rejects(
    tool.execute("write-failure", input, undefined, undefined, context()),
    (error: unknown) => error === writeError,
  );

  const controller = new AbortController();
  const cancelled = createEditDiagnosticsToolDefinition("/workspace", {
    operations: {
      ...operations,
      readFile: async () => {
        controller.abort();
        return Buffer.from("item();\n");
      },
    },
  });
  await assert.rejects(
    cancelled.execute("cancelled", input, controller.signal, undefined, context()),
    { message: "Operation aborted" },
  );
});
