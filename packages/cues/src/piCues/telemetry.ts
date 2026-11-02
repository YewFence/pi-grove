/**
 * Local telemetry: every fired cue is appended as one JSON line under the
 * user cache dir (`~/.cache/pi-cues/events.jsonl` by default), tagged with
 * the pi session id. Written to answer one question — "did pi-cues actually
 * fire?" — after the session is gone. All I/O failures are swallowed: the
 * telemetry sink must never break the injection pipeline.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TriggeredRecord } from "./triggers.js";

/** Rotate once the active file grows past this; events are rare and small. */
const MAX_EVENT_FILE_BYTES = 2 * 1024 * 1024;

export interface TelemetryEvent {
  ts: string;
  sessionId: string;
  action: string;
  target: string;
  source: string;
  loaded: boolean;
}

/** Follows XDG_CACHE_HOME like any user-level CLI tool. */
export function resolveCacheDir(): string {
  const xdg = process.env["XDG_CACHE_HOME"];
  return xdg && xdg !== "" ? join(xdg, "pi-cues") : join(homedir(), ".cache", "pi-cues");
}

export function telemetryEventFile(cacheDir: string): string {
  return join(cacheDir, "events.jsonl");
}

/**
 * Record one fired cue. Failures (unwritable dir, rotated-away file, …) are
 * silent: the caller cannot react usefully and must not be disrupted.
 */
export function recordTriggeredEvent(
  cacheDir: string,
  sessionId: string,
  record: TriggeredRecord,
): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    const file = telemetryEventFile(cacheDir);
    if (existsSync(file) && statSync(file).size > MAX_EVENT_FILE_BYTES) {
      renameSync(file, `${file}.1`);
    }
    const event: TelemetryEvent = {
      ts: new Date().toISOString(),
      sessionId,
      action: record.action,
      target: record.target,
      source: record.source,
      loaded: record.loaded,
    };
    appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // intentional
  }
}
