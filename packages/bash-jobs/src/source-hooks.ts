import { spawn } from "node:child_process";

/** Context for generating shell setup before a bash command starts. */
export interface SourceHookContext {
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  notify?: (message: string, type: "info" | "warning" | "error") => void;
}

/** Produces bash code; undefined skips initialization for this hook. */
export interface SourceHook {
  name: string;
  sourceCode(ctx: SourceHookContext): string | undefined | Promise<string | undefined>;
}

export interface CommandSourceHookConfig {
  name: string;
  command: string[];
  timeoutMs: number;
}

const MAX_SOURCE_BYTES = 1024 * 1024;

function commandOutput(config: CommandSourceHookConfig, ctx: SourceHookContext): Promise<string> {
  return new Promise((resolve, reject) => {
    if (ctx.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const child = spawn(config.command[0]!, config.command.slice(1), {
      cwd: ctx.cwd,
      env: ctx.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
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
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure ??= new Error(`unable to start command (${error.code ?? "unknown error"})`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(signal ? `terminated by ${signal}` : `exited with code ${code}`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** Runs an argv command and returns its stdout as bash setup, reporting failure transitions once. */
export function createCommandSourceHook(config: CommandSourceHookConfig): SourceHook {
  let failing = false;
  return {
    name: config.name,
    async sourceCode(ctx) {
      try {
        const code = await commandOutput(config, ctx);
        if (failing) {
          failing = false;
          ctx.notify?.(`${config.name} source hook recovered`, "info");
        }
        return code || undefined;
      } catch (error) {
        if (ctx.signal?.aborted) return undefined;
        if (!failing) {
          failing = true;
          ctx.notify?.(
            `${config.name} source hook failing: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
        return undefined;
      }
    },
  };
}
