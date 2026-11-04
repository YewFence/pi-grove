import type { Clock } from "./clock.js";

/** One uninterrupted span of effective work, with both clocks anchored. */
export interface TimeSlice {
  startMono: number;
  endMono: number;
  startWall: number;
  endWall: number;
}

export type SegmentKind = "file" | "app";

export interface SpanRecord {
  requestId: number;
  role: "request" | "segment";
  kind?: SegmentKind;
  /** Absolute path; only present on confirmed file-modification segments. */
  file?: string;
  startWall: number;
  endWall: number;
  durationMs: number;
}

const EPSILON_MS = 0.001;

export function sliceDuration(slice: TimeSlice): number {
  return slice.endMono - slice.startMono;
}

/**
 * Partitions the pending timeline into `parts` equal-duration, contiguous,
 * non-overlapping groups: total attribution is conserved, and no file can
 * claim the same wall time as another. Wall times are interpolated inside
 * each slice; durations always come from the monotonic clock.
 */
export function splitSlices(slices: readonly TimeSlice[], parts: number): TimeSlice[][] {
  const result: TimeSlice[][] = Array.from({ length: parts }, () => []);
  const total = slices.reduce((sum, slice) => sum + sliceDuration(slice), 0);
  if (total <= EPSILON_MS || parts <= 0) return result;
  let bucket = 0;
  let boundary = total / parts;
  let consumed = 0;
  for (const slice of slices) {
    let cursor = slice.startMono;
    while (slice.endMono - cursor > EPSILON_MS) {
      while (consumed >= boundary - EPSILON_MS && bucket < parts - 1) {
        bucket += 1;
        boundary = ((bucket + 1) * total) / parts;
      }
      const remaining = slice.endMono - cursor;
      const take = bucket >= parts - 1 ? remaining : Math.min(remaining, boundary - consumed);
      if (take > EPSILON_MS) result[bucket]?.push(pieceOf(slice, cursor, cursor + take));
      cursor += take;
      consumed += take;
    }
  }
  return result;
}

function pieceOf(slice: TimeSlice, startMono: number, endMono: number): TimeSlice {
  const span = sliceDuration(slice);
  const atWall = (mono: number) =>
    span <= 0
      ? slice.startWall
      : slice.startWall + ((mono - slice.startMono) / span) * (slice.endWall - slice.startWall);
  return { startMono, endMono, startWall: atWall(startMono), endWall: atWall(endMono) };
}

/**
 * The local attribution ledger: owns effective-work slices, wait pauses and
 * settlement. It knows nothing about pi events, files or the network.
 *
 * Invariants (see docs/pi-usage/design.md):
 * - every slice of effective work is settled at most once;
 * - file attribution + app attribution == effective work; waits stay outside;
 * - a period shared by several files is split, never duplicated;
 * - a new request never inherits the previous request's unsettled time.
 */
export class Ledger {
  private requestId = 0;
  private requestStartWall = 0;
  private active = false;
  private closed = false;
  private waitDepth = 0;
  private openStart: { mono: number; wall: number } | null = null;
  private pending: TimeSlice[] = [];
  private turnFiles = new Set<string>();

  constructor(
    private readonly clock: Clock,
    private readonly emit: (record: SpanRecord) => void,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  isWaiting(): boolean {
    return this.waitDepth > 0;
  }

  pendingDurationMs(): number {
    const settled = this.pending.reduce((sum, slice) => sum + sliceDuration(slice), 0);
    const open = this.openStart ? this.clock.nowMono() - this.openStart.mono : 0;
    return settled + open;
  }

  beginRequest(): void {
    if (this.closed) return;
    if (this.active) this.endRequest();
    this.active = true;
    this.requestId += 1;
    this.requestStartWall = this.clock.nowWall();
    this.pending = [];
    this.turnFiles.clear();
    if (this.waitDepth === 0) this.openSlice();
  }

  endRequest(): void {
    if (!this.active) return;
    this.closeSlice();
    this.settlePendingAsApp();
    const endWall = this.clock.nowWall();
    this.emit({
      requestId: this.requestId,
      role: "request",
      startWall: this.requestStartWall,
      endWall,
      durationMs: Math.max(0, endWall - this.requestStartWall),
    });
    this.active = false;
    this.turnFiles.clear();
  }

  pause(): void {
    if (this.closed) return;
    this.waitDepth += 1;
    if (this.waitDepth === 1) this.closeSlice();
  }

  resume(): void {
    if (this.closed || this.waitDepth === 0) return;
    this.waitDepth -= 1;
    if (this.waitDepth === 0 && this.active) this.openSlice();
  }

  beginTurn(): void {
    if (!this.closed) this.turnFiles.clear();
  }

  /** Only confirmed content changes may call this; success reports do not count. */
  recordModification(absolutePath: string): void {
    if (!this.closed && this.active) this.turnFiles.add(absolutePath);
  }

  /** Settles one edit batch: pending time is split equally across the modified files. */
  endTurn(): void {
    if (this.closed || !this.active || this.turnFiles.size === 0) return;
    const files = [...this.turnFiles].sort();
    this.turnFiles.clear();
    this.closeSlice();
    const parts = splitSlices(this.pending, files.length);
    this.pending = [];
    files.forEach((file, index) => {
      for (const piece of parts[index] ?? []) this.emitSegment("file", piece, file);
    });
    if (this.waitDepth === 0) this.openSlice();
  }

  close(): void {
    this.endRequest();
    this.closed = true;
  }

  private openSlice(): void {
    if (this.openStart) return;
    this.openStart = { mono: this.clock.nowMono(), wall: this.clock.nowWall() };
  }

  private closeSlice(): void {
    if (!this.openStart) return;
    const { mono, wall } = this.openStart;
    this.openStart = null;
    const endMono = this.clock.nowMono();
    const endWall = this.clock.nowWall();
    if (endMono - mono > EPSILON_MS) {
      this.pending.push({ startMono: mono, endMono, startWall: wall, endWall });
    }
  }

  private settlePendingAsApp(): void {
    for (const slice of this.pending) this.emitSegment("app", slice);
    this.pending = [];
  }

  private emitSegment(kind: SegmentKind, slice: TimeSlice, file?: string): void {
    this.emit({
      requestId: this.requestId,
      role: "segment",
      kind,
      file,
      startWall: slice.startWall,
      endWall: slice.endWall,
      durationMs: sliceDuration(slice),
    });
  }
}
