import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { OtlpAttribute, OtlpSpan } from "./spans.js";

export interface ExporterOptions {
  /** Full traces URL, e.g. `https://tempo.example.com/otlp/v1/traces`. */
  endpoint: string;
  headers: Record<string, string>;
  resourceAttributes: OtlpAttribute[];
  scopeVersion: string;
  /** JSON snapshot of the unsent queue; spans survive crashes through this file. */
  stateFile: string;
  maxQueue?: number;
  batchSize?: number;
  requestTimeoutMs?: number;
  maxBackoffMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface ExporterStats {
  queued: number;
  sent: number;
  dropped: number;
  lastError?: string;
}

const DEFAULT_MAX_QUEUE = 2000;
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1000;

/**
 * Bounded, single-flight OTLP/HTTP sender. Event handling never waits on the
 * network: spans enter the queue, one drain loop sends them with exponential
 * backoff, and the queue is mirrored to disk so a crash loses at most the
 * in-flight ledger, never settled-but-unsent spans. `flush` only bounds the
 * same loop with a deadline, so spans can never be sent twice by concurrent
 * senders.
 *
 * No background timers: sends happen in response to enqueues and flushes.
 */
export class OtlpExporter {
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly requestTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  private queue: OtlpSpan[] = [];
  private drainPromise: Promise<void> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private wake: (() => void) | null = null;
  private closedFlag = false;
  private flushDeadline: number | null = null;
  private backoffMs = BASE_BACKOFF_MS;
  private sent = 0;
  private dropped = 0;
  private lastError: string | undefined;

  constructor(private readonly options: ExporterOptions) {
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleep ?? ((ms) => this.interruptibleSleep(ms));
  }

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.stateFile, "utf8"));
      if (Array.isArray(parsed)) this.queue = parsed as OtlpSpan[];
    } catch {
      // Missing or corrupt state file: start empty rather than guessing.
    }
  }

  enqueue(span: OtlpSpan): void {
    if (this.closedFlag) return;
    if (this.queue.length >= this.maxQueue) {
      this.queue.splice(0, this.queue.length - this.maxQueue + 1);
      this.dropped += 1;
    }
    this.queue.push(span);
    this.flushDeadline = null;
    this.persist();
    this.kick();
  }

  stats(): ExporterStats {
    return {
      queued: this.queue.length,
      sent: this.sent,
      dropped: this.dropped,
      lastError: this.lastError,
    };
  }

  /** Bounded drain used at shutdown; leftover spans stay in the state file. */
  async flush(deadlineMs: number): Promise<void> {
    this.flushDeadline = Date.now() + deadlineMs;
    this.kick();
    this.wake?.();
    await this.drainPromise;
    await this.persistChain;
  }

  async close(): Promise<void> {
    this.closedFlag = true;
    this.wake?.();
    await this.drainPromise;
    await this.persistChain;
  }

  private kick(): void {
    this.drainPromise ??= this.drain().finally(() => {
      this.drainPromise = null;
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.closedFlag || this.queue.length === 0) return;
      if (this.flushDeadline !== null && Date.now() >= this.flushDeadline) return;
      // The batch leaves the queue while in flight, so overflow eviction can
      // only drop spans that were never attempted, and close() requeues it.
      const batch = this.queue.splice(0, this.batchSize);
      try {
        await this.post(batch);
        this.sent += batch.length;
        this.backoffMs = BASE_BACKOFF_MS;
        this.persist();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.queue.unshift(...batch);
        while (this.queue.length > this.maxQueue) {
          this.queue.shift();
          this.dropped += 1;
        }
        this.persist();
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
        let wait = this.backoffMs;
        if (this.flushDeadline !== null) {
          wait = Math.min(wait, Math.max(0, this.flushDeadline - Date.now()));
        }
        if (wait > 0) await this.sleepImpl(wait);
      }
    }
  }

  private async post(spans: OtlpSpan[]): Promise<void> {
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: this.options.resourceAttributes },
          scopeSpans: [{ scope: { name: "pi-usage", version: this.options.scopeVersion }, spans }],
        },
      ],
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.options.headers },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OTLP HTTP ${response.status}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolvePromise();
      };
    });
  }

  private persist(): void {
    // Snapshot synchronously: the queue may change before the chained write runs.
    const serialized = JSON.stringify(this.queue);
    this.persistChain = this.persistChain.then(async () => {
      try {
        await mkdir(dirname(this.options.stateFile), { recursive: true });
        const tmp = `${this.options.stateFile}.tmp`;
        await writeFile(tmp, serialized);
        await rename(tmp, this.options.stateFile);
      } catch {
        // Persistence is best-effort; the in-memory queue remains authoritative.
      }
    });
  }
}
