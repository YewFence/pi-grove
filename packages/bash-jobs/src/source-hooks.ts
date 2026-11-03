import { spawn } from "node:child_process";
import type { HookDiagnostic } from "./envelope.ts";

/** Context for generating shell setup before a bash command starts. */
export interface SourceHookContext {
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  notify?: (message: string, type: "info" | "warning" | "error") => void;
  report?: (diagnostic: HookDiagnostic) => void;
}

/** Produces bash code; undefined skips initialization for this hook. */
export interface SourceHook {
  name: string;
  quiet?: boolean;
  sourceCode(ctx: SourceHookContext): string | undefined | Promise<string | undefined>;
}

export interface CommandSourceHookConfig {
  name: string;
  command: string[];
  timeoutMs: number;
  quiet?: boolean;
  reportStderrOnSuccess?: boolean;
}

const MAX_SOURCE_BYTES = 1024 * 1024;

class CommandHookError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

function commandOutput(
  config: CommandSourceHookConfig,
  ctx: SourceHookContext,
): Promise<{ code: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (ctx.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const child = spawn(config.command[0]!, config.command.slice(1), {
      cwd: ctx.cwd,
      env: ctx.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let stderrTruncated = false;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => child.kill());
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
        }
      }
    };
    const abort = () => stop(new Error("aborted"));
    const timer = setTimeout(
      () => stop(new Error(`timed out after ${config.timeoutMs}ms`)),
      config.timeoutMs,
    );
    ctx.signal?.addEventListener("abort", abort, { once: true });
    if (ctx.signal?.aborted) abort();
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > MAX_SOURCE_BYTES) stop(new Error("stdout exceeds 1 MiB"));
      else if (!failure) chunks.push(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      const remaining = 8_192 - stderrBytes;
      if (data.length > remaining) stderrTruncated = true;
      if (remaining > 0) {
        const part = data.subarray(0, remaining);
        stderrChunks.push(part);
        stderrBytes += part.length;
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure ??= new Error(`unable to start command (${error.code ?? "unknown error"})`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", abort);
      const message =
        failure?.message ??
        (code !== 0
          ? signal
            ? `terminated by ${signal}`
            : `exited with code ${code}`
          : undefined);
      const stderr =
        Buffer.concat(stderrChunks).toString("utf8") +
        (stderrTruncated ? "\n[Stderr output truncated.]" : "");
      if (message) reject(new CommandHookError(message, stderr));
      else resolve({ code: Buffer.concat(chunks).toString("utf8"), stderr });
    });
  });
}

/** Runs an argv command and reports stderr and failures according to their independent settings. */
export function createCommandSourceHook(config: CommandSourceHookConfig): SourceHook {
  let failing = false;
  return {
    name: config.name,
    quiet: config.quiet,
    async sourceCode(ctx) {
      try {
        const { code, stderr } = await commandOutput(config, ctx);
        if (stderr && config.reportStderrOnSuccess !== false) {
          ctx.report?.({
            action: "source-hook",
            outcome: "warning",
            hook: config.name,
            message:
              "Hook exited with code 0. Its generated initialization code will run before the requested command.",
            stderr,
          });
        }
        if (failing) {
          failing = false;
          if (config.quiet) ctx.notify?.(`${config.name} source hook recovered`, "info");
        }
        return code || undefined;
      } catch (error) {
        if (ctx.signal?.aborted) return undefined;
        const message = error instanceof Error ? error.message : String(error);
        if (!config.quiet) {
          ctx.report?.({
            action: "source-hook",
            hook: config.name,
            message,
            stderr: error instanceof CommandHookError ? error.stderr : undefined,
          });
        } else if (!failing) {
          ctx.notify?.(`${config.name} source hook failing: ${message}`, "warning");
        }
        failing = true;
        return undefined;
      }
    },
  };
}
