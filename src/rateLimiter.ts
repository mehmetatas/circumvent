/**
 * A rolling-window request counter for a single limiter.
 *
 * Timestamps are held in a FIFO queue implemented as an array plus a head index,
 * so recording a request is amortized O(1): each timestamp is appended once and
 * skipped once when it falls out of the window. The array is compacted
 * occasionally so memory stays proportional to the requests inside the active
 * window rather than to everything the limiter has ever seen.
 *
 * This class is deliberately unaware of accounts, endpoints and the values in
 * config/rate-limits.json: it only knows a count and a window length.
 */
export class RollingWindowCounter {
  private timestamps: number[] = [];
  private head = 0;
  private readonly windowMs: number;
  private over = false;

  constructor(
    private readonly limit: number,
    windowSeconds: number,
  ) {
    this.windowMs = windowSeconds * 1000;
  }

  /** Number of requests currently inside the window. */
  get count(): number {
    return this.timestamps.length - this.head;
  }

  /**
   * Records a request at time `t` (epoch milliseconds) and reports the resulting
   * state. The active window is `(t - W, t]`: timestamps at or before `t - W`
   * are evicted, then `t` is added, then the count is compared with the limit.
   *
   * The request that pushes the count past the limit stays in the window, and
   * subsequent requests keep being counted while the limiter is over.
   */
  record(t: number): { count: number; transition: "start" | "end" | null } {
    this.evict(t - this.windowMs);
    this.timestamps.push(t);

    const count = this.count;
    const isOver = count > this.limit;
    const transition = isOver === this.over ? null : isOver ? "start" : "end";
    this.over = isOver;

    return { count, transition };
  }

  /**
   * Evicts requests that have left the window as of `now` and reports whether the
   * limiter is then idle (empty and not violating), i.e. whether the caller may
   * discard it. A limiter that is currently over its limit is never idle, so an
   * in-progress violation is never dropped. Discarding an idle limiter is a
   * no-op: recreating it later yields the same state.
   */
  pruneIfIdle(now: number): boolean {
    if (this.over) {
      return false;
    }
    this.evict(now - this.windowMs);
    return this.count === 0;
  }

  /** Removes every timestamp at or before `cutoff`, so the window is `(cutoff, t]`. */
  private evict(cutoff: number): void {
    const { timestamps } = this;
    while (this.head < timestamps.length && timestamps[this.head]! <= cutoff) {
      this.head++;
    }
    // Reclaim the consumed prefix once it dominates the array.
    if (this.head > 32 && this.head * 2 >= timestamps.length) {
      this.timestamps = timestamps.slice(this.head);
      this.head = 0;
    }
  }
}
