import { describe, expect, it } from "vitest";

import type { Clock } from "../src/clock.js";
import { Ledger, splitSlices, type SpanRecord, type TimeSlice } from "../src/ledger.js";

class FakeClock implements Clock {
  mono = 0;
  wall = 1_700_000_000_000;
  advance(ms: number): void {
    this.mono += ms;
    this.wall += ms;
  }
  nowMono(): number {
    return this.mono;
  }
  nowWall(): number {
    return this.wall;
  }
}

function harness() {
  const clock = new FakeClock();
  const records: SpanRecord[] = [];
  const ledger = new Ledger(clock, (record) => records.push(record));
  return { clock, records, ledger };
}

function segments(records: SpanRecord[]): SpanRecord[] {
  return records.filter((record) => record.role === "segment");
}

function totalFor(records: SpanRecord[], predicate: (record: SpanRecord) => boolean): number {
  return segments(records)
    .filter(predicate)
    .reduce((sum, record) => sum + record.durationMs, 0);
}

describe("Ledger", () => {
  it("reproduces the design-doc example: 90s Python, wait, 40s split over two TS files, 15s app", () => {
    const { clock, records, ledger } = harness();
    const SECOND = 1000;

    ledger.beginRequest();
    clock.advance(90 * SECOND);
    ledger.beginTurn();
    ledger.recordModification("/repo/a.py");
    ledger.endTurn();

    ledger.pause();
    clock.advance(120 * SECOND); // waiting on the user: excluded everywhere
    ledger.resume();

    clock.advance(40 * SECOND);
    ledger.beginTurn();
    ledger.recordModification("/repo/b.ts");
    ledger.recordModification("/repo/c.ts");
    ledger.endTurn();

    clock.advance(15 * SECOND);
    ledger.endRequest();

    expect(totalFor(records, (r) => r.file === "/repo/a.py")).toBeCloseTo(90 * SECOND, 3);
    expect(totalFor(records, (r) => r.file === "/repo/b.ts")).toBeCloseTo(20 * SECOND, 3);
    expect(totalFor(records, (r) => r.file === "/repo/c.ts")).toBeCloseTo(20 * SECOND, 3);
    expect(totalFor(records, (r) => r.kind === "app")).toBeCloseTo(15 * SECOND, 3);

    const effective = segments(records).reduce((sum, record) => sum + record.durationMs, 0);
    expect(effective).toBeCloseTo(145 * SECOND, 3);

    // Segments are contiguous and never overlap: b.ts hands over to c.ts exactly.
    const ordered = segments(records).sort((a, b) => a.startWall - b.startWall);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]!.startWall).toBeGreaterThanOrEqual(ordered[i - 1]!.endWall - 0.01);
    }
    const waitStart = 90 * SECOND;
    const waitEnd = 210 * SECOND;
    for (const record of segments(records)) {
      const overlapsWait =
        record.startWall - 1_700_000_000_000 < waitEnd &&
        record.endWall - 1_700_000_000_000 > waitStart;
      expect(overlapsWait).toBe(false);
    }
  });

  it("a new request settles the previous remainder as app and inherits nothing", () => {
    const { clock, records, ledger } = harness();
    ledger.beginRequest();
    clock.advance(30_000);
    ledger.beginRequest(); // second request begins while the first is unsettled
    clock.advance(10_000);
    ledger.beginTurn();
    ledger.recordModification("/repo/x.ts");
    ledger.endTurn();
    ledger.endRequest();

    const appMs = totalFor(records, (r) => r.kind === "app");
    expect(appMs).toBeCloseTo(30_000, 3);
    expect(totalFor(records, (r) => r.file === "/repo/x.ts")).toBeCloseTo(10_000, 3);
    expect(segments(records).every((r) => r.file !== "/repo/x.ts" || r.requestId === 2)).toBe(true);
  });

  it("keeps accumulating when a turn has no confirmed modification", () => {
    const { clock, records, ledger } = harness();
    ledger.beginRequest();
    clock.advance(60_000); // pure investigation turn
    ledger.beginTurn();
    ledger.endTurn();
    clock.advance(20_000);
    ledger.beginTurn();
    ledger.recordModification("/repo/config.yaml");
    ledger.endTurn();
    ledger.endRequest();

    // The earlier investigation time flows into the first confirmed edit batch.
    expect(totalFor(records, (r) => r.file === "/repo/config.yaml")).toBeCloseTo(80_000, 3);
    expect(totalFor(records, (r) => r.kind === "app")).toBeCloseTo(0, 3);
  });

  it("a whole investigation-only request settles entirely as app activity", () => {
    const { clock, records, ledger } = harness();
    ledger.beginRequest();
    clock.advance(20 * 60_000);
    ledger.endRequest();

    expect(totalFor(records, (r) => r.kind === "app")).toBeCloseTo(20 * 60_000, 3);
  });

  it("time after the last modification settles as app, not back-filled onto the file", () => {
    const { clock, records, ledger } = harness();
    ledger.beginRequest();
    clock.advance(10_000);
    ledger.beginTurn();
    ledger.recordModification("/repo/a.py");
    ledger.endTurn();
    clock.advance(5_000); // explanation and wrap-up
    ledger.endRequest();

    expect(totalFor(records, (r) => r.file === "/repo/a.py")).toBeCloseTo(10_000, 3);
    expect(totalFor(records, (r) => r.kind === "app")).toBeCloseTo(5_000, 3);
  });

  it("nested waits pause once and resume only when fully unwound", () => {
    const { clock, records, ledger } = harness();
    ledger.beginRequest();
    clock.advance(10_000);
    ledger.pause();
    clock.advance(5_000);
    ledger.pause();
    clock.advance(5_000);
    ledger.resume(); // still waiting: depth 1
    clock.advance(5_000);
    ledger.resume(); // now working again
    clock.advance(10_000);
    ledger.beginTurn();
    ledger.recordModification("/repo/a.py");
    ledger.endTurn();
    ledger.endRequest();

    // Only the two 10s working periods are attributed.
    expect(totalFor(records, (r) => r.file === "/repo/a.py")).toBeCloseTo(20_000, 3);
  });

  it("a wait opened before the request blocks accumulation until it ends", () => {
    const { clock, records, ledger } = harness();
    ledger.pause(); // e.g. a startup dialog outside any run
    ledger.beginRequest();
    clock.advance(10_000);
    expect(ledger.pendingDurationMs()).toBeCloseTo(0, 3);
    ledger.resume();
    clock.advance(5_000);
    ledger.beginTurn();
    ledger.recordModification("/repo/a.py");
    ledger.endTurn();
    ledger.endRequest();

    expect(totalFor(records, (r) => r.file === "/repo/a.py")).toBeCloseTo(5_000, 3);
  });

  it("emits no file segment when the pending time is zero", () => {
    const { records, ledger } = harness();
    ledger.beginRequest();
    ledger.beginTurn();
    ledger.recordModification("/repo/a.py");
    ledger.endTurn();
    ledger.endRequest();

    expect(segments(records).filter((r) => r.kind === "file")).toHaveLength(0);
  });

  it("endRequest and close are idempotent", () => {
    const { clock, records, ledger } = harness();
    ledger.beginRequest();
    clock.advance(1_000);
    ledger.endRequest();
    ledger.endRequest();
    ledger.close();
    ledger.close();
    ledger.beginRequest();
    clock.advance(1_000);
    ledger.endTurn();

    expect(records.filter((r) => r.role === "request")).toHaveLength(1);
    expect(segments(records)).toHaveLength(1); // the single app segment
  });

  it("ignores modifications recorded outside an active request", () => {
    const { clock, records, ledger } = harness();
    ledger.recordModification("/repo/a.py");
    ledger.beginRequest();
    clock.advance(1_000);
    ledger.endTurn();
    ledger.endRequest();

    expect(segments(records).filter((r) => r.kind === "file")).toHaveLength(0);
  });

  it("spans emitted for one request share its requestId", () => {
    const { clock, records, ledger } = harness();
    ledger.beginRequest();
    clock.advance(10_000);
    ledger.beginTurn();
    ledger.recordModification("/repo/a.py");
    ledger.recordModification("/repo/b.py");
    ledger.endTurn();
    clock.advance(1_000);
    ledger.endRequest();

    expect(new Set(records.map((r) => r.requestId))).toEqual(new Set([1]));
  });
});

describe("splitSlices", () => {
  const slice = (startMono: number, endMono: number): TimeSlice => ({
    startMono,
    endMono,
    startWall: 1_000 + startMono,
    endWall: 1_000 + endMono,
  });

  it("splits one slice into equal contiguous parts", () => {
    const parts = splitSlices([slice(0, 100)], 4);
    expect(
      parts.map((part) => part.reduce((sum, s) => sum + (s.endMono - s.startMono), 0)),
    ).toEqual([25, 25, 25, 25]);
    expect(parts[0]![0]!.endMono).toBeCloseTo(parts[1]![0]!.startMono, 6);
  });

  it("conserves total across gapped slices and interpolates wall time", () => {
    const parts = splitSlices([slice(0, 50), slice(200, 300)], 2);
    const totals = parts.map((part) => part.reduce((sum, s) => sum + (s.endMono - s.startMono), 0));
    expect(totals[0]).toBeCloseTo(75, 6);
    expect(totals[1]).toBeCloseTo(75, 6);
    const all = parts.flat().sort((a, b) => a.startMono - b.startMono);
    expect(all[0]!.startWall).toBeCloseTo(1_000, 6);
    const last = all[all.length - 1]!;
    expect(last.endWall).toBeCloseTo(1_300, 6);
  });

  it("handles more parts than slices and empty input", () => {
    const parts = splitSlices([slice(0, 10)], 3);
    const nonEmpty = parts.filter((part) => part.length > 0);
    expect(nonEmpty.flat().reduce((sum, s) => sum + (s.endMono - s.startMono), 0)).toBeCloseTo(
      10,
      6,
    );
    expect(splitSlices([], 2)).toEqual([[], []]);
    expect(splitSlices([slice(0, 0)], 2)).toEqual([[], []]);
  });
});
