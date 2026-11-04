/**
 * Durations are measured with a monotonic clock; wall time is only an anchor
 * for span timestamps, so system clock jumps cannot produce negative spans.
 */
export interface Clock {
  /** Milliseconds from a monotonic source. */
  nowMono(): number;
  /** Milliseconds since the Unix epoch. */
  nowWall(): number;
}

export const systemClock: Clock = {
  nowMono: () => performance.now(),
  nowWall: () => Date.now(),
};
