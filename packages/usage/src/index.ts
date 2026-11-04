/**
 * pi-usage entry point: adapts pi lifecycle events into the local attribution
 * ledger and exports settled segments as OTLP spans.
 *
 * Wiring notes:
 * - File snapshots happen in `tool_call` (awaited before execution), so the
 *   before-state is guaranteed to predate the write; `tool_execution_start`
 *   would race the mutation.
 * - Watches are compared at `turn_end` (batch settlement) and again before
 *   request settlement, so aborted turns cannot leak watches or lose
 *   confirmed partial modifications.
 * - `agent_end` is deliberately ignored: retries, compaction recovery and
 *   queued work continue the current request. Only `agent_settled` ends it.
 */
import { readFileSync } from "node:fs";
import { hostname, type as osType } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { systemClock } from "./clock.js";
import { loadConfig, type UsageConfig } from "./config.js";
import { snapshotFile, statesEqual, type FileState } from "./files.js";
import { languageForPath } from "./language.js";
import { Ledger, type SpanRecord } from "./ledger.js";
import { OtlpExporter, type ExporterStats } from "./otlp.js";
import { detectProject, type ProjectInfo } from "./project.js";
import { attr, buildSpan, traceIdForSession, type OtlpAttribute } from "./spans.js";

const VERSION = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as { version: string }
).version;

const MODIFICATION_TOOLS = new Set(["edit", "write"]);

interface PathWatch {
  before: FileState;
  ready: Promise<void>;
}

class SessionStats {
  segmentCount = 0;
  fileMs = 0;
  appMs = 0;
  byLanguage = new Map<string, number>();
  byFile = new Map<string, number>();

  add(record: SpanRecord): void {
    if (record.role !== "segment") return;
    this.segmentCount += 1;
    if (record.kind === "file" && record.file) {
      this.fileMs += record.durationMs;
      this.byFile.set(record.file, (this.byFile.get(record.file) ?? 0) + record.durationMs);
      const language = languageForPath(record.file);
      if (language) {
        this.byLanguage.set(language, (this.byLanguage.get(language) ?? 0) + record.durationMs);
      }
    } else {
      this.appMs += record.durationMs;
    }
  }
}

interface SessionRuntime {
  config: UsageConfig;
  project: ProjectInfo;
  ledger: Ledger;
  exporter: OtlpExporter | null;
  watches: Map<string, PathWatch>;
  stats: SessionStats;
  shutDown: boolean;
}

export default function (pi: ExtensionAPI) {
  let runtime: SessionRuntime | null = null;

  pi.registerCommand("pi-usage", {
    description: "Show pi-usage export status and session time totals",
    handler: async (_args, ctx) => {
      ctx.ui.notify(renderStatus(runtime), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();
    const project = config.projectOverride
      ? { root: ctx.cwd, name: config.projectOverride }
      : await detectProject(ctx.cwd);
    const stats = new SessionStats();
    const traceId = traceIdForSession(ctx.sessionManager.getSessionId());
    const exporter =
      config.enabled && config.endpoint
        ? new OtlpExporter({
            endpoint: config.endpoint,
            headers: config.headers,
            resourceAttributes: resourceAttributes(config),
            scopeVersion: VERSION,
            stateFile: config.stateFile,
          })
        : null;
    if (exporter) await exporter.load();
    const ledger = new Ledger(systemClock, (record) => {
      stats.add(record);
      exporter?.enqueue(
        buildSpan(
          record,
          {
            projectRoot: project.root,
            projectName: project.name,
            entityMode: config.entityMode,
          },
          traceId,
        ),
      );
    });
    runtime = {
      config,
      project,
      ledger,
      exporter,
      watches: new Map(),
      stats,
      shutDown: false,
    };
  });

  pi.on("before_agent_start", () => runtime?.ledger.beginRequest());

  pi.on("agent_start", () => {
    // Runs without a preceding before_agent_start (recovery, queued work)
    // still need an open request to accumulate time into.
    if (runtime && !runtime.ledger.isActive()) runtime.ledger.beginRequest();
  });

  pi.on("agent_settled", async () => {
    if (runtime) await settleRequest(runtime);
  });

  pi.on("ui_prompt_start", () => runtime?.ledger.pause());
  pi.on("ui_prompt_end", () => runtime?.ledger.resume());

  pi.on("turn_start", () => runtime?.ledger.beginTurn());

  pi.on("tool_call", async (event, ctx) => {
    const rt = runtime;
    if (!rt || !MODIFICATION_TOOLS.has(event.toolName)) return;
    const raw = (event.input as { path?: unknown }).path;
    if (typeof raw !== "string") return;
    const absolute = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
    if (rt.watches.has(absolute)) return; // overlap group keeps the earliest before-state
    const watch: PathWatch = { before: { kind: "unknown" }, ready: Promise.resolve() };
    watch.ready = snapshotFile(absolute).then((state) => {
      watch.before = state;
    });
    rt.watches.set(absolute, watch);
    await watch.ready;
  });

  pi.on("turn_end", async () => {
    if (!runtime) return;
    await resolveWatches(runtime);
    runtime.ledger.endTurn();
  });

  pi.on("session_shutdown", async () => {
    if (runtime) await shutdown(runtime);
  });

  async function settleRequest(rt: SessionRuntime): Promise<void> {
    await resolveWatches(rt);
    rt.ledger.endTurn();
    rt.ledger.endRequest();
  }

  async function shutdown(rt: SessionRuntime): Promise<void> {
    if (rt.shutDown) return;
    rt.shutDown = true;
    await settleRequest(rt);
    rt.ledger.close();
    await rt.exporter?.flush(5000);
    await rt.exporter?.close();
    runtime = null;
  }
}

async function resolveWatches(rt: SessionRuntime): Promise<void> {
  const watches = [...rt.watches.entries()];
  rt.watches.clear();
  await Promise.all(
    watches.map(async ([absolute, watch]) => {
      await watch.ready;
      const after = await snapshotFile(absolute);
      if (!statesEqual(watch.before, after)) rt.ledger.recordModification(absolute);
    }),
  );
}

function resourceAttributes(config: UsageConfig): OtlpAttribute[] {
  const attributes = [
    attr("service.name", "pi-usage"),
    attr("service.version", VERSION),
    attr("host.name", hostname()),
    attr("os.type", osType()),
  ];
  for (const [key, value] of Object.entries(config.resourceAttributes)) {
    attributes.push(attr(key, value));
  }
  return attributes;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderStatus(rt: SessionRuntime | null): string {
  if (!rt) return "pi-usage: no active session";
  const lines = [
    `pi-usage: ${rt.config.enabled ? "exporting" : "inactive"}`,
    rt.config.enabled
      ? `endpoint: ${rt.config.endpoint}`
      : `reason: ${rt.config.disabledReason ?? "unknown"}`,
    `project: ${rt.project.name} (${rt.project.root})`,
    `session: ${formatDuration(rt.stats.fileMs + rt.stats.appMs)} effective ` +
      `(files ${formatDuration(rt.stats.fileMs)}, app ${formatDuration(rt.stats.appMs)}, ` +
      `${rt.stats.segmentCount} segments)`,
  ];
  if (rt.stats.byLanguage.size > 0) {
    const top = [...rt.stats.byLanguage.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([language, ms]) => `${language} ${formatDuration(ms)}`)
      .join(", ");
    lines.push(`languages: ${top}`);
  }
  if (rt.exporter) {
    const stats: ExporterStats = rt.exporter.stats();
    lines.push(
      `queue: ${stats.queued} pending, ${stats.sent} sent, ${stats.dropped} dropped` +
        (stats.lastError ? `, last error: ${stats.lastError}` : ""),
    );
  }
  return lines.join("\n");
}
