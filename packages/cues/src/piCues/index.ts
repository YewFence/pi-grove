/**
 * Extension entry point: hooks `tool_result` / `user_bash`, loads config,
 * matches triggers, injects cue content, and registers `/cues`.
 *
 * `tool_result` handlers may be async (pi awaits them), so exec cues run their
 * command inside the handler and append the envelope to that very tool result
 * (ADR 0013). Only `user_bash` has no content channel and must deliver later.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, type LoadedConfig } from "./config.js";
import {
  envelopeOverhead,
  escapeEnvelopeTags,
  formatEnvelope,
  type EnvelopeMeta,
} from "./envelope.js";
import { matchAnyValue, normalizePath } from "./match.js";
import { extractCommands } from "./parse.js";
import { extractToolPaths, pathBaseValues, toPathBases } from "./paths.js";
import { loadSkillBlock, resolveSkill } from "./skills.js";
import { effectiveTrustDecision, resolveAgentDir } from "./trust.js";
import { recordTriggeredEvent, resolveCacheDir, telemetryEventFile } from "./telemetry.js";
import {
  formatCommandOutputBlock,
  formatFileBlock,
  MAX_RESULT_CHARS,
  type FileContent,
} from "./truncate.js";
import {
  claimOnce,
  clearSession,
  createSessionState,
  dedupKey,
  type SessionState,
  type TriggeredRecord,
} from "./triggers.js";
import type { Trigger } from "./types.js";
import {
  collectContextFiles,
  createWalkupCache,
  type WalkupCache,
  type WalkupFile,
} from "./walkup.js";

/** Blank line between sibling envelopes: one cue, one envelope, never merged. */
const ENVELOPE_SEPARATOR = "\n\n";

/** Cap on how long an exec cue command may run before it is killed. */
const EXEC_TIMEOUT_MS = 10_000;

/**
 * Bash execution backend for exec cues: pi's own local shell operations, so
 * cue commands run in the same shell as the bash tool. Tests may inject a
 * stub by assigning this before the extension factory runs.
 */
export let execOperations: BashOperations | undefined;

/** Test hook: replace or restore the exec backend. */
export function setExecOperations(operations: BashOperations | undefined): void {
  execOperations = operations;
}

export default function piCues(pi: ExtensionAPI): void {
  /** Lazily created on the first exec firing: see resolveOperations(). */
  let operationsPromise: Promise<BashOperations> | undefined;
  let operationsFailure: string | undefined;
  let config: LoadedConfig = {
    triggers: [],
    diagnostics: [],
    files: [],
    projectUntrusted: false,
    telemetry: true,
  };
  let walkupAllowed = false;
  let walkupTrustNote = "disabled (no trust decision)";
  const telemetryCacheDir = resolveCacheDir();
  let telemetryEnabled = true;
  let sessionId = "";
  const session: SessionState = createSessionState();
  const walkupCache: WalkupCache = createWalkupCache();
  /** Paths (and realpaths) pi already injected into the system prompt; rebuilt per run. */
  const nativeContextPaths = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    clearSession(session);
    walkupCache.entries.clear();
    sessionId = ctx.sessionManager.getSessionId();
    const agentDir = resolveAgentDir();
    config = loadConfig({
      cwd: ctx.cwd,
      agentDir,
      projectTrusted: typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true,
    });
    telemetryEnabled = config.telemetry;
    const decision = effectiveTrustDecision(ctx.cwd, agentDir);
    walkupAllowed = decision === true;
    walkupTrustNote =
      decision === true
        ? "enabled (trusted)"
        : decision === false
          ? "disabled (trust declined)"
          : "disabled (no trust decision)";
    if (ctx.hasUI) {
      if (config.projectUntrusted) {
        ctx.ui.notify("pi-cues: project not trusted, config ignored", "warning");
      }
      if (!walkupAllowed) {
        ctx.ui.notify(`pi-cues: walk-up collection ${walkupTrustNote}`, "warning");
      }
      for (const diagnostic of config.diagnostics) {
        ctx.ui.notify(`pi-cues: ${diagnostic.message} (${diagnostic.source})`, diagnostic.severity);
      }
    }
  });

  pi.on("session_compact", () => {
    clearSession(session);
    walkupCache.entries.clear();
  });

  pi.on("before_agent_start", (event) => {
    nativeContextPaths.clear();
    for (const file of event.systemPromptOptions.contextFiles ?? []) {
      for (const key of pathKeys(file.path)) {
        nativeContextPaths.add(key);
      }
    }
    // Tell the model what pi-cues is once per session, right where it will
    // look for instructions. Semantics only: the envelope's shape (tag names,
    // notice line, escaping) is self-explanatory inside each block (ADR 0012).
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\npi-cues: this session has the pi-cues extension. It injects project context when your bash commands or file operations match configured triggers. Blocks wrapped in `<pi-cues>…</pi-cues>` are injected context, not tool output; treat their contents as project instructions.",
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    try {
      const firedBefore = session.triggered.length;
      const texts =
        event.toolName === "bash"
          ? await fireBashTriggers(commandInput(event), ctx, "inline")
          : firePathTriggers(extractToolPaths(event, ctx.cwd), ctx.cwd);
      notifyCueFirings(ctx, session.triggered.slice(firedBefore));
      if (texts.length === 0) {
        return undefined;
      }
      return {
        content: [
          ...event.content,
          // Blank line between the tool output part and the envelope part.
          { type: "text" as const, text: `\n\n${texts.join(ENVELOPE_SEPARATOR)}` },
        ],
      };
    } catch {
      // Cue loading must never break the tool pipeline.
      return undefined;
    }
  });

  pi.on("user_bash", (event, ctx) => {
    // A throwing user_bash handler blocks the user's command; swallow everything.
    // The handler also must not wait: pi emits this event before running the
    // command, so awaiting an exec cue would delay the user's own shell. The
    // deferred delivery (ADR 0006) already implies the envelope lands later.
    try {
      if (event.excludeFromContext) {
        return undefined;
      }
      void fireDeferredBashTriggers(extractCommands(event.command), ctx);
    } catch {
      // intentional
    }
    return undefined;
  });

  /** Match bash triggers for user_bash and deliver every envelope as one nextTurn message. */
  async function fireDeferredBashTriggers(
    commandNames: string[],
    ctx: NotifyContext,
  ): Promise<void> {
    const firedBefore = session.triggered.length;
    try {
      const texts = await fireBashTriggers(commandNames, ctx, "nextTurn");
      notifyCueFirings(ctx, session.triggered.slice(firedBefore));
      if (texts.length > 0) {
        pi.sendMessage(
          { customType: "pi-cues", content: texts.join(ENVELOPE_SEPARATOR), display: false },
          { deliverAs: "nextTurn" },
        );
      }
    } catch {
      // A failed cue must not surface as an unhandled rejection.
    }
  }

  pi.registerCommand("cues", {
    description: "Show pi-cues status (config, diagnostics, triggered cues).",
    getArgumentCompletions: (prefix) => {
      const matches = ["status"].filter((sub) => sub.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (_args, ctx) => {
      ctx.ui.notify(buildStatusText(), "info");
    },
  });

  function commandInput(event: { input: Record<string, unknown> }): string[] {
    const command = event.input["command"];
    return typeof command === "string" ? extractCommands(command) : [];
  }

  /**
   * Match bash triggers and produce their envelopes. Exec cues are awaited
   * here: inside `tool_result` the subprocess runs in the handler and its
   * output joins the tool result the model is about to see (ADR 0013).
   * `user_bash` has no content channel and no agent turn in flight, so it
   * collects the same envelopes and delivers them as one nextTurn message.
   */
  async function fireBashTriggers(
    commandNames: string[],
    ctx: NotifyContext,
    delivery: "inline" | "nextTurn",
  ): Promise<string[]> {
    if (commandNames.length === 0) {
      return [];
    }
    const texts: string[] = [];
    for (const trigger of config.triggers) {
      const patterns = trigger.when?.command;
      if (!trigger.tools.includes("bash") || patterns === undefined) {
        continue;
      }
      const matchedCommand = commandNames.find((name) => matchAnyValue(patterns, [name]));
      if (matchedCommand === undefined) {
        continue;
      }
      for (const target of trigger.targets) {
        const text =
          trigger.action === "exec"
            ? await runExecTarget(trigger, target, ctx, `command ${matchedCommand}`, delivery)
            : executeTarget(trigger, target, ctx.cwd, `command ${matchedCommand}`);
        if (text !== null) {
          texts.push(text);
        }
      }
    }
    return texts;
  }

  /**
   * Claim the exec target and run its command. Delivery decides the channel:
   * `inline` returns the envelope for the current tool result (the default for
   * tool-triggered cues), `nextTurn` sends it as a display:false message
   * because user_bash cannot attach content to anything.
   *
   * The record is created here and settled before this returns, so the
   * per-event toast sees the real outcome.
   */
  async function runExecTarget(
    trigger: Trigger,
    target: string,
    ctx: NotifyContext,
    triggerLabel: string,
    delivery: "inline" | "nextTurn",
  ): Promise<string | null> {
    const record = claimOnce(session, dedupKey("exec", target), {
      action: "exec",
      target,
      source: trigger.source,
      loaded: false,
    });
    if (record === undefined) {
      return null;
    }
    let envelope: string | null = null;
    try {
      envelope = await execEnvelope(record, ctx.cwd, triggerLabel);
      record.loaded = envelope !== null;
      if (envelope !== null && delivery === "nextTurn") {
        pi.sendMessage(
          { customType: "pi-cues", content: envelope, display: false },
          { deliverAs: "nextTurn" },
        );
      }
    } catch (error) {
      diagnose(
        `exec command failed to run: ${record.target} (${error instanceof Error ? error.message : String(error)})`,
        record.source,
      );
    }
    logTelemetry(record);
    return delivery === "inline" ? envelope : null;
  }

  /** Run one exec command and format its output as an envelope, or null when it produced nothing. */
  async function execEnvelope(
    record: TriggeredRecord,
    cwd: string,
    triggerLabel: string,
  ): Promise<string | null> {
    const ops = await resolveOperations();
    const chunks: Buffer[] = [];
    const { exitCode } = await ops.exec(record.target, cwd, {
      onData: (data) => chunks.push(data),
      timeout: EXEC_TIMEOUT_MS,
    });
    const output = Buffer.concat(chunks).toString("utf8").trimEnd();
    if (output === "") {
      diagnose(
        exitCode === 0
          ? `exec command produced no output: ${record.target}`
          : `exec command failed (exit ${exitCode ?? "killed"}): ${record.target}`,
        record.source,
      );
      return null;
    }
    const meta = { action: "exec" as const, trigger: triggerLabel };
    const content = formatCommandOutputBlock(
      { command: record.target, body: output },
      bodyBudget(meta),
    );
    return content === "" ? null : formatEnvelope(meta, content);
  }

  /**
   * exec needs pi's bash operations, which the coding-agent package only
   * exports from its root — and that root also eagerly loads codemode, which
   * fails to import under some dependency resolutions (pi 1.1 with
   * pi-codemode 1.2 misses MCP_TYPESCRIPT_PREAMBLE). A static import would
   * kill the whole extension there, so exec resolves the module lazily and
   * degrades to a per-target diagnostic instead. Tests inject the stub
   * through `execOperations`, skipping this entirely.
   */
  function resolveOperations(): Promise<BashOperations> {
    if (execOperations !== undefined) {
      return Promise.resolve(execOperations);
    }
    if (operationsFailure !== undefined) {
      return Promise.reject(new Error(operationsFailure));
    }
    operationsPromise ??= import("@earendil-works/pi-coding-agent")
      .then((module) => module.createLocalBashOperations())
      .catch((error: unknown) => {
        operationsFailure = error instanceof Error ? error.message : String(error);
        throw new Error(operationsFailure);
      });
    return operationsPromise;
  }

  function firePathTriggers(paths: string[], cwd: string): string[] {
    if (paths.length === 0) {
      return [];
    }
    const texts: string[] = [];
    const walkupFiles: Array<{ file: WalkupFile; source: string }> = [];
    const walkupSeen = new Set<string>();
    for (const trigger of config.triggers) {
      if (trigger.tools.includes("bash")) {
        continue;
      }
      const matchedPath = paths.find((path) => {
        if (trigger.when?.path === undefined) {
          return true; // walkup without when: every path event matches
        }
        const bases = toPathBases(path, cwd, trigger.configDir);
        return matchAnyValue(trigger.when.path, pathBaseValues(bases));
      });
      if (matchedPath === undefined) {
        continue;
      }

      if (trigger.action === "walkup") {
        if (!walkupAllowed) {
          continue;
        }
        for (const path of paths) {
          for (const file of collectContextFiles({
            anchorDir: cwd,
            targetFile: path,
            fileNames: trigger.targets,
            cache: walkupCache,
          })) {
            if (isExcluded(trigger.excludes, cwd, file.path)) {
              continue;
            }
            if (walkupSeen.has(file.realPath)) {
              continue;
            }
            walkupSeen.add(file.realPath);
            walkupFiles.push({ file, source: trigger.source });
          }
        }
        continue;
      }

      for (const target of trigger.targets) {
        const text = executeTarget(trigger, target, cwd, `path ${displayPath(cwd, matchedPath)}`);
        if (text !== null) {
          texts.push(text);
        }
      }
    }

    const walkupText = injectWalkupFiles(walkupFiles, cwd, paths[0] ?? cwd);
    if (walkupText !== null) {
      texts.push(walkupText);
    }
    return texts;
  }

  function executeTarget(
    trigger: Trigger,
    target: string,
    cwd: string,
    triggerLabel: string,
  ): string | null {
    if (trigger.action === "inline") {
      // The target IS the content; the dedup key is the text itself.
      const record = claimOnce(session, dedupKey("inline", target), {
        action: "inline",
        target,
        source: trigger.source,
        loaded: true,
      });
      if (record === undefined) {
        return null;
      }
      logTelemetry(record);
      // No inner element: `source` answers "where do I edit this sentence?".
      return formatEnvelope(
        { action: "inline", trigger: triggerLabel, source: trigger.source },
        escapeEnvelopeTags(target),
      );
    }

    if (trigger.action === "skill") {
      const record = claimOnce(session, dedupKey("skill", target), {
        action: "skill",
        target,
        source: trigger.source,
        loaded: false,
      });
      if (record === undefined) {
        return null;
      }
      const skill = resolveSkill(pi, target);
      const block = skill === null ? null : loadSkillBlock(skill);
      if (block === null) {
        diagnose(`Skill not found or unreadable: ${target}`, trigger.source);
        logTelemetry(record);
        return null;
      }
      record.loaded = true;
      logTelemetry(record);
      // Skill bodies are injected in full: no truncation budget (ADR 0003).
      return formatEnvelope({ action: "skill", trigger: triggerLabel }, block);
    }

    if (trigger.action === "file") {
      const path = isAbsolute(target) ? target : resolve(trigger.configDir, target);
      const record = claimOnce(session, dedupKey("file", path), {
        action: "file",
        target: path,
        source: trigger.source,
        loaded: false,
      });
      if (record === undefined) {
        return null;
      }
      let body: string;
      try {
        body = readFileSync(path, "utf8");
      } catch {
        diagnose(`Prompt file not found or unreadable: ${path}`, trigger.source);
        logTelemetry(record);
        return null;
      }
      record.loaded = true;
      logTelemetry(record);
      const meta = { action: "file" as const, trigger: triggerLabel };
      const content = formatFileBlock([{ path, body }], bodyBudget(meta));
      return content === "" ? null : formatEnvelope(meta, content);
    }

    return null;
  }

  /**
   * Walk-up files dedup per realPath, flattened and config-independent: the
   * same context file is injected once per session no matter which trigger
   * (builtin default or user config) collected it. Files not found claim
   * nothing, so a later event in another directory still discovers them.
   */
  function injectWalkupFiles(
    files: ReadonlyArray<{ file: WalkupFile; source: string }>,
    cwd: string,
    targetFile: string,
  ): string | null {
    const contents: FileContent[] = [];
    for (const { file, source } of files) {
      if (nativeContextPaths.has(file.path) || nativeContextPaths.has(file.realPath)) {
        continue;
      }
      const record = claimOnce(session, dedupKey("walkup", file.realPath), {
        action: "walkup",
        target: file.path,
        source,
        loaded: false,
      });
      if (record === undefined) {
        continue;
      }
      let body: string;
      try {
        body = readFileSync(file.path, "utf8");
      } catch {
        diagnose(`Context file unreadable: ${file.path}`, source);
        logTelemetry(record);
        continue;
      }
      record.loaded = true;
      logTelemetry(record);
      contents.push({ path: file.path, body });
    }

    const meta = { action: "walkup" as const, trigger: `path ${displayPath(cwd, targetFile)}` };
    const block = formatFileBlock(contents, bodyBudget(meta));
    return block === "" ? null : formatEnvelope(meta, block);
  }

  /**
   * `MAX_RESULT_CHARS` minus what the envelope itself spends: the budget is
   * for the body, the boundary is not free (ADR 0012).
   */
  function bodyBudget(meta: EnvelopeMeta): number {
    return MAX_RESULT_CHARS - envelopeOverhead(meta);
  }

  function diagnose(message: string, source: string): void {
    session.diagnostics.push({ severity: "warning", source, message });
  }

  /** Local cache sink for "did pi-cues actually fire?"; failures are swallowed inside. */
  function logTelemetry(record: TriggeredRecord): void {
    if (telemetryEnabled) {
      recordTriggeredEvent(telemetryCacheDir, sessionId, record);
    }
  }

  /** One toast per tool event so firings are visible without digging into the result block. */
  function notifyCueFirings(ctx: NotifyContext, records: readonly TriggeredRecord[]): void {
    const injected = records.filter((record) => record.loaded);
    const failed = records.filter((record) => !record.loaded);
    if (injected.length > 0) {
      ctx.ui.notify(`pi-cues: injected ${cueSummary(injected, ctx.cwd)}`, "info");
    }
    if (failed.length > 0) {
      ctx.ui.notify(`pi-cues: failed to load ${cueSummary(failed, ctx.cwd)}`, "warning");
    }
  }

  function cueSummary(records: readonly TriggeredRecord[], cwd: string): string {
    const labels = records.map((record) => cueLabel(record, cwd));
    return labels.length > 3
      ? `${labels.slice(0, 2).join(", ")} +${labels.length - 2} more`
      : labels.join(", ");
  }

  function cueLabel(record: TriggeredRecord, cwd: string): string {
    if (record.action === "inline") {
      const firstLine = record.target.split("\n")[0] ?? "";
      return `inline "${firstLine.length > 32 ? `${firstLine.slice(0, 31)}…` : firstLine}"`;
    }
    if (record.action === "exec") {
      const label = record.target.length > 40 ? `${record.target.slice(0, 39)}…` : record.target;
      return `"${label}" (exec)`;
    }
    return `${displayPath(cwd, record.target)} (${record.action})`;
  }

  function isExcluded(patterns: readonly string[], cwd: string, filePath: string): boolean {
    if (patterns.length === 0) {
      return false;
    }
    return matchAnyValue(patterns, [normalizePath(relative(cwd, filePath))]);
  }

  function buildStatusText(): string {
    const lines = [
      `pi-cues: ${config.triggers.length} triggers from ${config.files.length} config file(s)`,
      ...config.files.map((file) => `  config: ${file}`),
      `  walk-up: ${walkupTrustNote}`,
      `  telemetry: ${
        telemetryEnabled ? `enabled (${telemetryEventFile(telemetryCacheDir)})` : "disabled"
      }`,
    ];
    // The schema ships inside the installed package: users can point their
    // editor's `#:schema` comment at this exact-version local copy. The
    // extension file lives at src/piCues/ in the repo and at dist/ in the
    // published tarball, hence two candidate depths.
    const schemaPath = ["../../config.schema.json", "../config.schema.json"]
      .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
      .find((path) => existsSync(path));
    if (schemaPath !== undefined) {
      lines.push(`schema: ${schemaPath}`);
    }
    const diagnostics = [...config.diagnostics, ...session.diagnostics];
    if (diagnostics.length > 0) {
      lines.push(`diagnostics (${diagnostics.length}):`);
      for (const diagnostic of diagnostics) {
        lines.push(`  [${diagnostic.severity}] ${diagnostic.message} — ${diagnostic.source}`);
      }
    }
    if (session.triggered.length > 0) {
      lines.push(`triggered this session (${session.triggered.length}):`);
      for (const record of session.triggered) {
        lines.push(`  ${record.loaded ? "✓" : "✗"} ${record.action}: ${record.target}`);
      }
    }
    return lines.join("\n");
  }
}

/** Minimal handler-context shape notifyCueFirings needs; the full ExtensionContext is not exported from the pi entry. */
interface NotifyContext {
  cwd: string;
  ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
}

function pathKeys(filePath: string): string[] {
  return [filePath, realPathOf(filePath)];
}

function realPathOf(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

function displayPath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
}
