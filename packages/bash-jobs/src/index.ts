import { randomBytes } from "node:crypto";
import { appendFileSync, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  type BashOperations,
  createBashToolDefinition,
  createLocalBashOperations,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  SettingsManager,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadSourceHookConfig } from "./config.ts";
import { formatDiagnostic, type HookDiagnostic } from "./envelope.ts";
import { type SourceHook, createCommandSourceHook } from "./source-hooks.ts";
import { type JobSnapshot, registerShortcuts, renderWidget, type WidgetState } from "./widget.ts";

export interface JobTiming {
  /** Output silence that hands a still-running untimed command to the background; explicit timeouts are honored in full. */
  yieldIdleMs: number;
  /** Upper bound on blocking before a chatty command is handed to the background. */
  yieldMaxMs: number;
  /** Minimum wait for bash_wait on a job that stayed running; doubles each time. */
  waitFloorMs: number;
  waitMaxMs: number;
}

const DEFAULT_TIMING: JobTiming = {
  yieldIdleMs: 15_000,
  yieldMaxMs: 30 * 60_000,
  waitFloorMs: 30_000,
  waitMaxMs: 30 * 60_000,
};
const KILL_GRACE_MS = 5_000;
const MAX_UNREAD_BYTES = DEFAULT_MAX_BYTES * 4;

type JobState = "running" | "exited" | "killed" | "failed";
type YieldReason = "idle" | "max" | "timeout";

/** Tracks the longest gap between output chunks, including the gap still open at the time of reading. */
class SilenceMeter {
  private lastActivity = Date.now();
  private longestGap = 0;

  touch(): void {
    const now = Date.now();
    this.longestGap = Math.max(this.longestGap, now - this.lastActivity);
    this.lastActivity = now;
  }

  maxSilenceMs(): number {
    return Math.max(this.longestGap, Date.now() - this.lastActivity);
  }
}

interface Job {
  id: number;
  command: string;
  program: string;
  state: JobState;
  exitCode?: number;
  failure?: string;
  controller: AbortController;
  settled: Promise<void>;
  decoder: TextDecoder;
  unread: string;
  diagnostics: HookDiagnostic[];
  droppedUnread: boolean;
  log: WriteStream;
  logPath: string;
  nextWaitFloorMs: number;
  updatedAt: number;
  startedAt: number;
  silence: SilenceMeter;
  endRecorded: boolean;
}

interface YieldedRun {
  diagnostics: HookDiagnostic[];
  command: string;
  program: string;
  controller: AbortController;
  settled: Promise<{ exitCode: number | null }>;
  startedAt: number;
  silence: SilenceMeter;
  redirect: (sink: (data: Buffer) => void) => void;
}

function formatDurationMs(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
  return `${Math.round(seconds)}s`;
}

interface JobResultDetails {
  jobId?: unknown;
  waitedMs?: unknown;
}

function renderJobResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  theme: { fg: (color: "muted", text: string) => string },
): Text {
  const text = result.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
  const details: JobResultDetails | undefined =
    typeof result.details === "object" && result.details !== null ? result.details : undefined;
  const waitedMs = typeof details?.waitedMs === "number" ? details.waitedMs : undefined;
  const lines = text ? text.split("\n") : [];
  if (waitedMs !== undefined && lines.length > 0)
    lines[lines.length - 1] += theme.fg("muted", ` (waited ${formatDurationMs(waitedMs)})`);
  return new Text(lines.join("\n"), 0, 0);
}

type BashErrorKind = "exit_code" | "aborted" | "invalid_params" | "exec_failed";

type EventRecord =
  | {
      event: "bash";
      model?: string;
      program: string;
      timeoutSec?: number;
      elapsedMs: number;
      maxSilenceMs: number;
      yieldReason?: YieldReason;
      outcome: "exited" | "yielded" | "error";
      jobId?: number;
      errorKind?: BashErrorKind;
      exitCode?: number;
    }
  | {
      event: "job_end";
      jobId: number;
      program: string;
      state: JobState;
      exitCode?: number;
      lifetimeMs: number;
      maxSilenceMs: number;
    }
  | {
      event: "bash_wait";
      jobId: number;
      requestedMs?: number;
      waitedMs: number;
      state: JobState | "unknown";
    }
  | { event: "bash_kill"; jobId: number; waitedMs: number; state: JobState | "unknown" }
  | {
      event: "source_hook";
      hook: string;
      outcome: "ok" | "skipped" | "failed" | "disabled";
      elapsedMs: number;
      errorMessage?: string;
    };

/** Classifies a failed bash call from the built-in tool's error message; telemetry only, never thrown. */
function classifyError(error: unknown): { errorKind: BashErrorKind; exitCode?: number } {
  const message = error instanceof Error ? error.message : String(error);
  const exit = /Command exited with code (\d+)\s*$/.exec(message);
  if (exit) return { errorKind: "exit_code", exitCode: Number(exit[1]) };
  if (message.endsWith("Command aborted")) return { errorKind: "aborted" };
  if (message.startsWith("Invalid timeout")) return { errorKind: "invalid_params" };
  return { errorKind: "exec_failed" };
}

function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");
}

interface EventLog {
  record(sessionId: string, event: EventRecord): void;
  /** Synchronous append for shutdown-time events, when async stream flushes may never run. */
  recordSync(sessionId: string, event: EventRecord): void;
  close(): void;
}

function eventLine(sessionId: string, event: EventRecord): string {
  return `${JSON.stringify({ ts: new Date().toISOString(), session: sessionId, ...event })}\n`;
}

/** Appends one JSON line per event; telemetry must never break the tool it observes. */
function createEventLog(path: string): EventLog {
  let stream: WriteStream | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    stream = createWriteStream(path, { flags: "a" });
    stream.on("error", () => {});
  } catch {
    // Unwritable state dir: drop events.
  }
  return {
    record(sessionId, event) {
      try {
        stream?.write(eventLine(sessionId, event));
      } catch {
        // Drop the event.
      }
    },
    recordSync(sessionId, event) {
      try {
        appendFileSync(path, eventLine(sessionId, event));
      } catch {
        // Drop the event.
      }
    },
    close() {
      stream?.end();
    },
  };
}

type RecordEvent = (event: EventRecord) => void;

interface EventSink {
  record: RecordEvent;
  recordSync: RecordEvent;
}

/** First program name of a command line, without leading env assignments or directories, so arguments never reach disk. */
export function programName(command: string): string {
  for (const word of command.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    const bare = word.replace(/^[({!]+/, "");
    if (bare) return basename(bare).slice(0, 64);
  }
  return "";
}

function createJobTable(
  timing: JobTiming,
  events: EventSink,
  onJobChange: (reason: "output" | "state") => void,
) {
  let nextId = 1;
  const jobs = new Map<number, Job>();

  /** Records job_end exactly once; shutdown passes sync so the write lands before the process exits. */
  function recordEnd(job: Job, sync = false): void {
    if (job.endRecorded) return;
    job.endRecorded = true;
    const event: EventRecord = {
      event: "job_end",
      jobId: job.id,
      program: job.program,
      state: job.state,
      exitCode: job.exitCode,
      lifetimeMs: Date.now() - job.startedAt,
      maxSilenceMs: job.silence.maxSilenceMs(),
    };
    (sync ? events.recordSync : events.record)(event);
  }

  function append(job: Job, text: string): void {
    if (!text) return;
    job.unread += text;
    job.updatedAt = Date.now();
    if (job.unread.length > MAX_UNREAD_BYTES) {
      job.unread = job.unread.slice(-MAX_UNREAD_BYTES);
      job.droppedUnread = true;
    }
    onJobChange("output");
  }

  function adopt(run: YieldedRun): Job {
    const id = nextId++;
    const logPath = join(tmpdir(), `pi-bash-job-${id}-${randomBytes(4).toString("hex")}.log`);
    const now = Date.now();
    const job: Job = {
      id,
      command: run.command,
      program: run.program,
      state: "running",
      controller: run.controller,
      settled: Promise.resolve(),
      decoder: new TextDecoder(),
      unread: "",
      diagnostics: run.diagnostics,
      droppedUnread: false,
      log: createWriteStream(logPath),
      logPath,
      nextWaitFloorMs: timing.waitFloorMs,
      updatedAt: now,
      startedAt: run.startedAt,
      silence: run.silence,
      endRecorded: false,
    };
    run.redirect((data) => {
      job.log.write(data);
      append(job, job.decoder.decode(data, { stream: true }));
    });
    job.settled = run.settled
      .then(
        ({ exitCode }) => {
          job.state = "exited";
          job.exitCode = exitCode ?? 1;
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (message === "aborted") job.state = "killed";
          else {
            job.state = "failed";
            job.failure = message;
          }
        },
      )
      .finally(() => {
        append(job, job.decoder.decode());
        job.log.end();
        onJobChange("state");
        recordEnd(job);
      });
    jobs.set(id, job);
    onJobChange("state");
    return job;
  }

  function takeOutput(job: Job): string {
    const text = job.unread;
    const dropped = job.droppedUnread;
    job.unread = "";
    job.droppedUnread = false;
    const truncation = truncateTail(text, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    if (!truncation.truncated && !dropped) return text;
    return `${truncation.content}\n\n[Showing last ${formatSize(truncation.outputBytes)} of new output. Full output since backgrounding: ${job.logPath}]`;
  }

  return {
    adopt,
    takeOutput,
    get: (id: number) => jobs.get(id),
    forget: (id: number) => {
      const deleted = jobs.delete(id);
      if (deleted) onJobChange("state");
      return deleted;
    },
    listRunningJobs(tailChars: number): JobSnapshot[] {
      return Array.from(jobs.values())
        .filter((job) => job.state === "running")
        .map((job) => ({
          id: job.id,
          command: job.command,
          state: "running" as const,
          outputTail: job.unread.slice(-tailChars),
          updatedAt: job.updatedAt,
        }));
    },
    killJob(id: number): void {
      const job = jobs.get(id);
      if (job?.state === "running") job.controller.abort();
    },
    killAll(): void {
      for (const job of jobs.values()) {
        if (job.state !== "running") continue;
        // The process may exit before the settled promise fires, so record the end synchronously now.
        job.state = "killed";
        recordEnd(job, true);
        job.controller.abort();
      }
    },
  };
}

type JobTable = ReturnType<typeof createJobTable>;

interface YieldingRun {
  diagnostics: HookDiagnostic[];
  program: string;
  timeoutMs?: number;
  silence: SilenceMeter;
  startedAt: number;
  /** Resolves shell setup before spawning; cancellation prevents subsequent hooks from starting. */
  sourceCode?: (
    signal: AbortSignal,
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ) => Promise<string | undefined>;
  onYield: (job: Job, reason: YieldReason) => void;
}

/**
 * Wraps shell operations so a command still running when the yield window closes resolves early as success,
 * leaving the process attached to a background job. An explicit timeout is honored in full: only the timeout
 * (or the max ceiling) yields, never output silence. Untimed commands yield on silence instead, so a quiet
 * command cannot block the foreground indefinitely. Nothing is killed on timeout.
 */
function createYieldingOperations(
  base: BashOperations,
  jobs: JobTable,
  timing: JobTiming,
  run: YieldingRun,
): BashOperations {
  return {
    exec(command, cwd, options) {
      const controller = new AbortController();
      let sink = options.onData;
      let onActivity: (() => void) | undefined;
      let preparing = true;
      const settled = (async () => {
        const sourceCode = await run.sourceCode?.(controller.signal, cwd, options.env);
        preparing = false;
        if (controller.signal.aborted) throw new Error("aborted");
        const finalCommand = sourceCode ? `set -e\n${sourceCode}\nset +e\n${command}` : command;
        return base.exec(finalCommand, cwd, {
          ...options,
          timeout: undefined,
          signal: controller.signal,
          onData: (data) => {
            run.silence.touch();
            sink(data);
            onActivity?.();
          },
        });
      })();
      settled.catch(() => {});

      return new Promise((resolve, reject) => {
        let idleTimer: NodeJS.Timeout | undefined;
        let ceilingTimer: NodeJS.Timeout | undefined;
        let done = false;
        const forwardAbort = () => {
          controller.abort();
          if (preparing && !done) {
            finish();
            reject(new Error("aborted"));
          }
        };
        const finish = () => {
          done = true;
          clearTimeout(idleTimer);
          clearTimeout(ceilingTimer);
          options.signal?.removeEventListener("abort", forwardAbort);
          onActivity = undefined;
        };
        const yieldToBackground = (reason: YieldReason) => {
          if (done) return;
          finish();
          const job = jobs.adopt({
            diagnostics: run.diagnostics,
            command,
            program: run.program,
            controller,
            settled,
            startedAt: run.startedAt,
            silence: run.silence,
            redirect: (next) => {
              sink = next;
            },
          });
          run.onYield(job, reason);
          resolve({ exitCode: 0 });
        };
        const armIdle = () => {
          clearTimeout(idleTimer);
          if (run.timeoutMs !== undefined) return;
          idleTimer = setTimeout(() => yieldToBackground("idle"), timing.yieldIdleMs);
        };
        onActivity = armIdle;
        armIdle();
        const ceilingIsTimeout = run.timeoutMs !== undefined && run.timeoutMs < timing.yieldMaxMs;
        ceilingTimer = setTimeout(
          () => yieldToBackground(ceilingIsTimeout ? "timeout" : "max"),
          ceilingIsTimeout ? run.timeoutMs : timing.yieldMaxMs,
        );
        if (options.signal?.aborted) forwardAbort();
        else options.signal?.addEventListener("abort", forwardAbort, { once: true });
        settled.then(
          (result) => {
            if (done) return;
            finish();
            resolve(result);
          },
          (error: unknown) => {
            if (done) return;
            finish();
            reject(error);
          },
        );
      });
    },
  };
}

function waitForJob(job: Job, waitMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, waitMs);
    signal?.addEventListener("abort", done, { once: true });
    void job.settled.then(done);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

function timeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error("Invalid timeout: must be a finite number of seconds");
  return timeout * 1000;
}

function runningNote(id: number): string {
  return `The command is still running in the background as job_id ${id}.`;
}

const BASH_DESCRIPTION = `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Commands still running at timeout, or after a short idle when no timeout is set, continue in the background and return a job_id. Pass that job_id to bash_wait to wait for more output, or to bash_kill to stop the command.`;

const JOB_ID = Type.Number({
  description: "Background job ID, taken from the bash tool's 'still running as job_id N' note",
});

export interface BashJobsOptions extends Partial<JobTiming> {
  /** Additional hooks, applied after hooks from the user's config.toml. */
  sourceHooks?: SourceHook[];
}

export function createBashJobsExtension(options: BashJobsOptions = {}) {
  const timing: JobTiming = {
    yieldIdleMs: options.yieldIdleMs ?? DEFAULT_TIMING.yieldIdleMs,
    yieldMaxMs: options.yieldMaxMs ?? DEFAULT_TIMING.yieldMaxMs,
    waitFloorMs: options.waitFloorMs ?? DEFAULT_TIMING.waitFloorMs,
    waitMaxMs: options.waitMaxMs ?? DEFAULT_TIMING.waitMaxMs,
  };

  return function bashJobs(pi: ExtensionAPI): void {
    const eventLog = createEventLog(join(stateDir(), "pi-bash-jobs", "events.jsonl"));
    let sessionId = "";
    const record: RecordEvent = (event) => eventLog.record(sessionId, event);
    const recordSync: RecordEvent = (event) => eventLog.recordSync(sessionId, event);

    let sourceHooks: SourceHook[] = [];
    let configLoaded = false;
    let configDiagnostics: string[] = [];
    const explainedDiagnostics = new Set<string>();
    const diagnosticParts = (diagnostics: HookDiagnostic[], consume = true) => {
      const explained = new Set(explainedDiagnostics);
      const parts = diagnostics.map((diagnostic) => {
        const key = `${sessionId}:${diagnostic.outcome ?? "failed"}`;
        const text = formatDiagnostic(diagnostic, !explained.has(key));
        explained.add(key);
        return { type: "text" as const, text: `${text}\n\n` };
      });
      if (consume) {
        for (const key of explained) explainedDiagnostics.add(key);
        diagnostics.splice(0);
      }
      return parts;
    };
    const shutdownController = new AbortController();
    const loadHooks = (notify: (message: string, type: "warning") => void) => {
      const config = loadSourceHookConfig();
      sourceHooks = [...config.hooks.map(createCommandSourceHook), ...(options.sourceHooks ?? [])];
      configLoaded = true;
      configDiagnostics = config.diagnostics;
      for (const diagnostic of config.diagnostics) notify(`pi-bash-jobs: ${diagnostic}`, "warning");
    };
    pi.on("session_start", (_event, ctx) => {
      explainedDiagnostics.clear();
      loadHooks((message, type) => ctx.ui.notify(message, type));
    });

    const widgetState: WidgetState = { folded: true };
    let renderTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleRender = (reason: "output" | "state") => {
      const ctx = widgetState.ctx;
      if (!ctx) return;
      if (reason === "output") {
        if (renderTimer) return;
        renderTimer = setTimeout(() => {
          renderTimer = undefined;
          renderWidget(ctx, widgetState, jobs);
        }, 250);
      } else {
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = undefined;
        renderWidget(ctx, widgetState, jobs);
      }
    };

    const jobs = createJobTable(timing, { record, recordSync }, scheduleRender);
    const builtin = createBashToolDefinition(process.cwd());
    const executingCalls = new Set<string>();

    registerShortcuts(pi, widgetState, jobs);

    /** Delivers a job's new output with its status; terminal results remove the job and throw on failure like bash. */
    function report(job: Job, signal: AbortSignal | undefined, waitedMs?: number) {
      const output = jobs.takeOutput(job);
      const diagnostics = diagnosticParts(job.diagnostics).map((part) => part.text.trimEnd());
      const withStatus = (status: string) =>
        [...diagnostics, `${output ? `${output}\n\n` : ""}${status}`].join("\n\n");
      const reply = (status: string, waited?: number) => ({
        content: [{ type: "text" as const, text: withStatus(status) }],
        details: { jobId: job.id, waitedMs: waited ?? 0 },
      });
      if (job.state === "running") {
        if (signal?.aborted)
          throw new Error(withStatus(`Wait aborted; job_id ${job.id} is still running`));
        return reply(runningNote(job.id), waitedMs);
      }
      jobs.forget(job.id);
      if (job.state === "killed") return reply(`job_id ${job.id} killed`, waitedMs);
      if (job.state === "failed")
        throw new Error(withStatus(`job_id ${job.id} failed: ${job.failure}`));
      if (job.exitCode === 0) return reply(`job_id ${job.id} exited with code 0`, waitedMs);
      throw new Error(withStatus(`job_id ${job.id} exited with code ${job.exitCode}`));
    }

    const jobCommand = new Map<number, string>();
    function renderJobCall(action: string) {
      return (
        args: { job_id?: unknown; seconds?: unknown },
        theme: {
          fg: (color: "toolTitle" | "muted", text: string) => string;
          bold: (text: string) => string;
        },
      ) => {
        const id = typeof args.job_id === "number" ? args.job_id : undefined;
        const command =
          id === undefined ? undefined : (jobs.get(id)?.command ?? jobCommand.get(id));
        const wait = typeof args.seconds === "number" ? ` (wait ${args.seconds}s)` : "";
        return new Text(
          theme.fg("toolTitle", theme.bold(`${action} job ${id ?? "?"}`)) +
            theme.fg("muted", wait) +
            (command ? theme.fg("muted", ` ${command}`) : ""),
          0,
          0,
        );
      };
    }

    pi.registerTool({
      name: builtin.name,
      label: builtin.label,
      description: BASH_DESCRIPTION,
      promptSnippet: builtin.promptSnippet,
      promptGuidelines: builtin.promptGuidelines,
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute" }),
        timeout: Type.Optional(
          Type.Number({
            description: "Seconds to wait before backgrounding; honored in full (optional)",
          }),
        ),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        sessionId = ctx.sessionManager.getSessionId();
        widgetState.ctx = ctx;
        if (!configLoaded) loadHooks((message, type) => ctx.ui.notify(message, type));
        const settings = SettingsManager.create(ctx.cwd, undefined, {
          projectTrusted: ctx.isProjectTrusted(),
        });
        const silence = new SilenceMeter();
        const startedAt = Date.now();
        const program = programName(params.command);
        let yielded: { job: Job; reason: YieldReason } | undefined;
        const recordCall = (outcome: "exited" | "yielded" | "error", error?: unknown) =>
          record({
            event: "bash",
            model: ctx.model?.id,
            program,
            timeoutSec: params.timeout,
            elapsedMs: Date.now() - startedAt,
            maxSilenceMs: silence.maxSilenceMs(),
            yieldReason: yielded?.reason,
            outcome,
            jobId: yielded?.job.id,
            ...(error === undefined ? {} : classifyError(error)),
          });

        let timeout: number | undefined;
        try {
          timeout = timeoutMs(params.timeout);
        } catch (error) {
          recordCall("error", error);
          throw error;
        }
        const diagnostics: HookDiagnostic[] = [];
        const reportDiagnostic = (diagnostic: HookDiagnostic) => diagnostics.push(diagnostic);
        const resolveSourceCode = async (
          hookSignal: AbortSignal,
          cwd: string,
          env?: NodeJS.ProcessEnv,
        ): Promise<string | undefined> => {
          const sourceSignal = AbortSignal.any([hookSignal, shutdownController.signal]);
          const parts: string[] = [];
          if (!sourceSignal.aborted) {
            for (const message of configDiagnostics.splice(0))
              reportDiagnostic({ action: "config", message });
          }
          for (const hook of sourceHooks) {
            if (sourceSignal.aborted) throw new Error("aborted");
            const hookStart = Date.now();
            let code: string | undefined;
            try {
              code = await hook.sourceCode({
                cwd,
                env,
                signal: sourceSignal,
                report: reportDiagnostic,
                notify: (message, type) => ctx.ui.notify(message, type),
              });
            } catch (error) {
              if (!sourceSignal.aborted) {
                const message = error instanceof Error ? error.message : String(error);
                if (hook.quiet)
                  ctx.ui.notify(`${hook.name} source hook failing: ${message}`, "warning");
                else reportDiagnostic({ action: "source-hook", hook: hook.name, message });
              }
              record({
                event: "source_hook",
                hook: hook.name,
                outcome: "failed",
                elapsedMs: Date.now() - hookStart,
                errorMessage: error instanceof Error ? error.message : String(error),
              });
              continue;
            }
            if (code) {
              record({
                event: "source_hook",
                hook: hook.name,
                outcome: "ok",
                elapsedMs: Date.now() - hookStart,
              });
              parts.push(
                `# begin source-hook: ${hook.name}\n${code}\n# end source-hook: ${hook.name}`,
              );
            } else {
              record({
                event: "source_hook",
                hook: hook.name,
                outcome: "skipped",
                elapsedMs: Date.now() - hookStart,
              });
            }
          }
          if (sourceSignal.aborted) throw new Error("aborted");
          return parts.length > 0 ? parts.join("\n") : undefined;
        };
        const operations = createYieldingOperations(
          createLocalBashOperations({ shellPath: settings.getShellPath() }),
          jobs,
          timing,
          {
            diagnostics,
            program,
            timeoutMs: timeout,
            silence,
            startedAt,
            sourceCode: resolveSourceCode,
            onYield: (job, reason) => {
              yielded = { job, reason };
            },
          },
        );
        const tool = createBashToolDefinition(ctx.cwd, {
          operations,
          commandPrefix: settings.getShellCommandPrefix(),
        });
        let result: Awaited<ReturnType<typeof tool.execute>>;
        try {
          executingCalls.add(toolCallId);
          result = await tool.execute(
            toolCallId,
            params,
            signal,
            onUpdate
              ? (update) =>
                  onUpdate({
                    ...update,
                    content: [...diagnosticParts(diagnostics, false), ...update.content],
                  })
              : undefined,
            ctx,
          );
          if (result.isError) {
            throw new Error(
              result.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
            );
          }
        } catch (error) {
          recordCall("error", error);
          if (diagnostics.length)
            throw new Error(
              [
                ...diagnosticParts(diagnostics).map((part) => part.text.trimEnd()),
                error instanceof Error ? error.message : String(error),
              ].join("\n\n"),
            );
          throw error;
        } finally {
          executingCalls.delete(toolCallId);
        }
        recordCall(yielded ? "yielded" : "exited");
        if (!yielded)
          return { ...result, content: [...diagnosticParts(diagnostics), ...result.content] };
        jobCommand.set(yielded.job.id, yielded.job.command);
        const text = result.content.find((item) => item.type === "text")?.text;
        const output = text && text !== "(no output)" ? `${text}\n\n` : "";
        return {
          content: [
            ...diagnosticParts(diagnostics),
            { type: "text", text: `${output}${runningNote(yielded.job.id)}` },
          ],
          details: { ...result.details, jobId: yielded.job.id },
        };
      },
      renderCall(args, theme, context) {
        // Pi emits tool_execution_start before approval; the first execution update reaches here after execute begins.
        return builtin.renderCall!(args, theme, {
          ...context,
          executionStarted: executingCalls.has(context.toolCallId),
        });
      },
      renderResult: builtin.renderResult,
    });

    pi.registerTool({
      name: "bash_wait",
      label: "bash_wait",
      description:
        "Wait for a background bash job to exit or until the wait interval elapses, then return output produced since the last read",
      parameters: Type.Object({
        job_id: JOB_ID,
        seconds: Type.Optional(Type.Number({ description: "Wait interval in seconds" })),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        sessionId = ctx.sessionManager.getSessionId();
        const requestedMs = params.seconds === undefined ? undefined : params.seconds * 1000;
        const startedAt = Date.now();
        const job = jobs.get(params.job_id);
        if (!job) {
          record({
            event: "bash_wait",
            jobId: params.job_id,
            requestedMs,
            waitedMs: 0,
            state: "unknown",
          });
          throw new Error(`Unknown job_id ${params.job_id}`);
        }
        if (job.state === "running") {
          const waitMs = Math.min(
            timing.waitMaxMs,
            Math.max(job.nextWaitFloorMs, requestedMs ?? 0),
          );
          await waitForJob(job, waitMs, signal);
          if (job.state === "running") job.nextWaitFloorMs = Math.min(timing.waitMaxMs, waitMs * 2);
        }
        const waitedMs = Date.now() - startedAt;
        record({ event: "bash_wait", jobId: job.id, requestedMs, waitedMs, state: job.state });
        return report(job, signal, waitedMs);
      },
      renderCall: renderJobCall("wait"),
      renderResult: (result, _options, theme) => renderJobResult(result, theme),
    });

    pi.registerTool({
      name: "bash_kill",
      label: "bash_kill",
      description: "Terminate a background bash job and return its remaining output",
      parameters: Type.Object({ job_id: JOB_ID }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        sessionId = ctx.sessionManager.getSessionId();
        const startedAt = Date.now();
        const job = jobs.get(params.job_id);
        if (!job) {
          record({ event: "bash_kill", jobId: params.job_id, waitedMs: 0, state: "unknown" });
          throw new Error(`Unknown job_id ${params.job_id}`);
        }
        if (job.state === "running") {
          job.controller.abort();
          await waitForJob(job, KILL_GRACE_MS, undefined);
        }
        record({
          event: "bash_kill",
          jobId: job.id,
          waitedMs: Date.now() - startedAt,
          state: job.state,
        });
        return report(job, undefined);
      },
      renderCall: renderJobCall("kill"),
    });

    pi.on("session_shutdown", () => {
      shutdownController.abort();
      jobs.killAll();
      eventLog.close();
    });
  };
}

export default createBashJobsExtension();
