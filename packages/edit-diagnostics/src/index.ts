import assert from "node:assert/strict";
import { constants, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { finished } from "node:stream/promises";
import {
  createEditToolDefinition,
  type EditOperations,
  type EditToolOptions,
  type ExtensionAPI,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";

function whitespaceCandidate(content: string, oldText: string) {
  const needle = oldText.replace(/\s/gu, "");
  if (!needle) return undefined;

  const offsets: number[] = [];
  const characters: string[] = [];
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (!/\s/u.test(character)) {
      characters.push(character);
      offsets.push(index);
    }
  }
  const compactContent = characters.join("");
  const matchIndex = compactContent.indexOf(needle);
  if (matchIndex === -1 || compactContent.indexOf(needle, matchIndex + 1) !== -1) return undefined;

  let start = offsets[matchIndex];
  let end = offsets[matchIndex + needle.length - 1] + 1;
  if (/^[\t ]/u.test(oldText)) {
    const lineStart = content.lastIndexOf("\n", start - 1) + 1;
    if (!content.slice(lineStart, start).trim()) start = lineStart;
  }
  if (/\s$/u.test(oldText)) {
    while (end < content.length && /[^\S\n]/u.test(content[end])) end++;
    if (oldText.endsWith("\n") && content[end] === "\n") end++;
  }

  const candidate = content.slice(start, end);
  const startLine = content.slice(0, start).split("\n").length;
  const endLine = content.slice(0, end - (candidate.endsWith("\n") ? 1 : 0)).split("\n").length;
  return { text: candidate, startLine, endLine };
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n|\r/gu, "\n");
}

const MAX_FOLLOW_UP_CALLS = 5;

type TelemetryPhase = "edit_result" | "follow_up_result";

interface TelemetryEvent {
  event: "edit_diagnostics";
  phase: TelemetryPhase;
  model?: string;
  toolName: string;
  input: Record<string, unknown>;
  toolCallId: string;
  triggerCallId: string;
  isError: boolean;
  diagnostic?: boolean;
  step?: number;
}

interface FollowUpTrail {
  triggerCallId: string;
  remaining: number;
  calls: Map<string, { step: number; triggerCallId: string }>;
}

function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");
}

function createEventLog(path: string) {
  let stream: WriteStream | undefined;
  return {
    record(sessionId: string, event: TelemetryEvent) {
      try {
        if (!stream) {
          mkdirSync(dirname(path), { recursive: true });
          stream = createWriteStream(path, { flags: "a" });
          stream.on("error", () => {});
        }
        stream.write(
          JSON.stringify({ ts: new Date().toISOString(), session: sessionId, ...event }) + "\n",
        );
      } catch {
        // Telemetry must never break the tool it observes.
      }
    },
    async close() {
      if (!stream) return;
      stream.end();
      await finished(stream).catch(() => {});
    },
  };
}

function observeToolSequence(pi: ExtensionAPI): void {
  const eventLog = createEventLog(join(stateDir(), "pi-edit-diagnostics", "events.jsonl"));
  const trails = new Map<string, FollowUpTrail>();

  pi.on("tool_call", (event: ToolCallEvent, ctx) => {
    if (!["read", "edit", "write"].includes(event.toolName)) return;
    const trail = trails.get(ctx.sessionManager.getSessionId());
    if (!trail || trail.remaining === 0) return;
    trail.calls.set(event.toolCallId, {
      step: MAX_FOLLOW_UP_CALLS - trail.remaining + 1,
      triggerCallId: trail.triggerCallId,
    });
    trail.remaining--;
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    let trail = trails.get(sessionId);
    const followUp = trail?.calls.get(event.toolCallId);
    const failedEdit = event.toolName === "edit" && event.isError;
    if (!followUp && !failedEdit) return;
    trail?.calls.delete(event.toolCallId);
    eventLog.record(sessionId, {
      event: "edit_diagnostics",
      phase: followUp ? "follow_up_result" : "edit_result",
      model: ctx.model?.id,
      toolName: event.toolName,
      input: event.input,
      toolCallId: event.toolCallId,
      triggerCallId: followUp?.triggerCallId ?? event.toolCallId,
      isError: event.isError,
      step: followUp?.step,
      diagnostic: failedEdit
        ? event.content.some(
            (part) => part.type === "text" && part.text.includes("No changes were written."),
          )
        : undefined,
    });
    if (failedEdit) {
      if (!trail) {
        trail = {
          triggerCallId: event.toolCallId,
          remaining: MAX_FOLLOW_UP_CALLS,
          calls: new Map(),
        };
        trails.set(sessionId, trail);
      }
      trail.triggerCallId = event.toolCallId;
      trail.remaining = MAX_FOLLOW_UP_CALLS;
    } else if (trail?.remaining === 0 && trail.calls.size === 0) {
      trails.delete(sessionId);
    }
  });

  pi.on("session_shutdown", async () => {
    trails.clear();
    await eventLog.close();
  });
}

function explainNotFound(
  error: Error,
  snapshot: string,
  input: { path: string; edits: { oldText: string; newText: string }[] },
): Error {
  const editIndex =
    input.edits.length === 1
      ? error.message.startsWith("Could not find the exact text in ") &&
        error.message.endsWith(
          ". The old text must match exactly including all whitespace and newlines.",
        )
        ? 0
        : -1
      : (() => {
          const match =
            /^Could not find edits\[(\d+)\] in .+\. The oldText must match exactly including all whitespace and newlines\.$/u.exec(
              error.message,
            );
          return match ? Number(match[1]) : -1;
        })();
  if (editIndex === -1) return error;

  const oldText = normalizeLineEndings(input.edits[editIndex].oldText);
  const content = normalizeLineEndings(snapshot.replace(/^\uFEFF/u, ""));
  const candidate = whitespaceCandidate(content, oldText);
  const lines = [
    input.edits.length === 1
      ? "Could not find the exact text."
      : `Could not find edits[${editIndex}].`,
  ];
  if (candidate && candidate.text !== oldText) {
    lines.push(
      `A unique candidate differs only in whitespace at lines ${candidate.startLine}-${candidate.endLine}.`,
      `Your input (oldText): ${JSON.stringify(oldText)}`,
      `File content:         ${JSON.stringify(candidate.text)}`,
    );
  } else {
    lines.push(
      "No exact or supported fuzzy match was found. Re-read the file and copy the source text exactly, including indentation and blank lines.",
    );
  }
  lines.push("No changes were written.");
  return new Error(lines.join("\n"), { cause: error });
}

/** Create a native edit tool with diagnostics based on the same read snapshot. */
export function createEditDiagnosticsToolDefinition(
  cwd: string,
  options?: EditToolOptions,
): ReturnType<typeof createEditToolDefinition> {
  const native = createEditToolDefinition(cwd);
  const operations: EditOperations = options?.operations ?? {
    access: (path) => access(path, constants.R_OK | constants.W_OK),
    readFile,
    writeFile: (path, content) => writeFile(path, content, "utf8"),
  };
  return {
    ...native,
    async execute(toolCallId, input, signal, onUpdate, ctx) {
      let snapshot: Buffer | undefined;
      let writeStarted = false;
      const tool = createEditToolDefinition(cwd, {
        operations: {
          ...operations,
          async readFile(path) {
            const buffer = await operations.readFile(path);
            snapshot = buffer;
            return buffer;
          },
          async writeFile(path, content) {
            writeStarted = true;
            await operations.writeFile(path, content);
          },
        },
      });
      try {
        return await tool.execute(toolCallId, input, signal, onUpdate, ctx);
      } catch (error) {
        if (error instanceof Error && snapshot !== undefined && !writeStarted && !signal?.aborted) {
          throw explainNotFound(error, snapshot.toString("utf8"), input);
        }
        throw error;
      }
    },
    renderCall(args, theme, context) {
      if (context.isError) return new Container();
      return native.renderCall!(args, theme, context);
    },
    renderResult(result, renderOptions, theme, context) {
      if (!context.isError) return native.renderResult!(result, renderOptions, theme, context);
      // The execution result owns the error body; a fresh header must not start another preview.
      const box = native.renderCall!(context.args, theme, {
        ...context,
        argsComplete: false,
        state: {},
        lastComponent: undefined,
      });
      assert.ok(box instanceof Box, "The native edit header must render as a Box.");
      box.setBgFn((text) => theme.bg("toolErrorBg", text));
      const text = result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      box.addChild(new Spacer(1));
      box.addChild(new Text(theme.fg("error", text), 0, 0));
      return box;
    },
  };
}

/** Replace the built-in edit tool while retaining its parameters and native success rendering. */
export default function editDiagnostics(pi: ExtensionAPI): void {
  observeToolSequence(pi);
  pi.registerTool(createEditDiagnosticsToolDefinition(process.cwd()));
}
