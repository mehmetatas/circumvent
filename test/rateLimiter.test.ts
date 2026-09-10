import { describe, expect, it } from "@jest/globals";
import { RollingWindowCounter } from "../src/rateLimiter.js";

/** Seconds -> epoch milliseconds, so the cases read in whole seconds. */
const t = (seconds: number): number => seconds * 1000;

describe("RollingWindowCounter", () => {
  it("counts requests inside the window and reports no transition below the limit", () => {
    const counter = new RollingWindowCounter(3, 60);

    expect(counter.record(t(0))).toStrictEqual({ count: 1, transition: null });
    expect(counter.record(t(1))).toStrictEqual({ count: 2, transition: null });
    expect(counter.record(t(2))).toStrictEqual({ count: 3, transition: null });
  });

  it("transitions once on the way over the limit and stays over", () => {
    const counter = new RollingWindowCounter(3, 60);
    for (const second of [0, 1, 2]) {
      counter.record(t(second));
    }

    expect(counter.record(t(3))).toStrictEqual({ count: 4, transition: "start" });
    expect(counter.record(t(4))).toStrictEqual({ count: 5, transition: null });
  });

  it("treats the window as (t - W, t], excluding the request exactly W old", () => {
    const counter = new RollingWindowCounter(3, 60);
    for (const second of [0, 1, 2]) {
      counter.record(t(second));
    }

    // At 60s the request from 0s is exactly W old, so it drops out: still 3.
    expect(counter.record(t(60))).toStrictEqual({ count: 3, transition: null });
    // At 61s the 1s request also drops out.
    expect(counter.record(t(61))).toStrictEqual({ count: 3, transition: null });
  });

  it("transitions back once when the window drains", () => {
    const counter = new RollingWindowCounter(2, 60);
    counter.record(t(0));
    counter.record(t(1));

    expect(counter.record(t(2))).toStrictEqual({ count: 3, transition: "start" });
    expect(counter.record(t(120))).toStrictEqual({ count: 1, transition: "end" });
    expect(counter.record(t(121))).toStrictEqual({ count: 2, transition: null });
  });

  it("counts a burst of identical timestamps", () => {
    const counter = new RollingWindowCounter(1, 60);
    counter.record(t(5));

    expect(counter.record(t(5))).toStrictEqual({ count: 2, transition: "start" });
  });

  it("stays O(1) per request over a long run, reclaiming the consumed prefix", () => {
    const counter = new RollingWindowCounter(10, 5);
    // 5000 requests one second apart: the window never holds more than 5.
    for (let second = 0; second < 5000; second++) {
      const { count } = counter.record(t(second));
      expect(count).toBeLessThanOrEqual(5);
    }

    expect(counter.count).toBeLessThanOrEqual(5);
  });

  describe("pruneIfIdle", () => {
    it("reports a drained limiter as idle", () => {
      const counter = new RollingWindowCounter(5, 60);
      counter.record(t(0));

      expect(counter.pruneIfIdle(t(30))).toBe(false);
      expect(counter.pruneIfIdle(t(60))).toBe(true);
      expect(counter.count).toBe(0);
    });

    it("never reports a violating limiter as idle, however old its requests", () => {
      const counter = new RollingWindowCounter(1, 60);
      counter.record(t(0));
      counter.record(t(1));

      expect(counter.pruneIfIdle(t(10_000))).toBe(false);
    });
  });
});
