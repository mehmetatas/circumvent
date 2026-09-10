import type { RateLimitPolicy } from "./policy.js";
import { RollingWindowCounter } from "./rateLimiter.js";
import { formatTimestamp } from "./timestamps.js";
import type { Limit, Scope, ValidRequest, ViolationEvent } from "./types.js";

/**
 * Two kinds of response are left out of the rate-limit windows:
 *
 * - 429, the server's own rate-limit rejection. Counting it would treat that
 *   rejection as extra traffic that caused the violation, so a client would look
 *   worse the harder the server pushed back.
 * - 5xx, a server-side failure. The client should not be charged against its
 *   quota for a request the server failed to serve.
 *
 * Everything else — 2xx, 3xx and 4xx other than 429 — counts. All of these
 * responses still appear in the traffic statistics; see the README.
 */
export const countsTowardRateLimit = (statusCode: number): boolean => statusCode !== 429 && statusCode < 500;

/** How often, in recorded requests, idle limiters are swept out of the map. */
const SWEEP_INTERVAL = 10_000;

type Limiter = {
  counter: RollingWindowCounter;
  /** The event currently in progress for this limiter, if it is over its limit. */
  open: ViolationEvent | null;
};

/**
 * Applies the rate-limit policy to a stream of requests and turns threshold
 * crossings into violation events.
 *
 * Each (client, scope, endpoint) triple gets its own independent limiter, so
 * account and endpoint limits are evaluated separately and clients never share
 * state. A violation event starts when a limiter's rolling window goes from at
 * or below the limit to above it, and ends when a later request finds it back at
 * or below the limit; requests in between extend the same event instead of
 * creating new ones.
 */
export class ViolationTracker {
  private readonly limiters = new Map<string, Limiter>();
  private readonly events: ViolationEvent[] = [];
  private recordedSinceSweep = 0;

  constructor(private readonly policy: RateLimitPolicy) {}

  /**
   * Feeds one valid request to the limiters that apply to it. Requests that do
   * not count toward rate limits (429 and 5xx) are ignored here, but are still
   * part of the traffic statistics collected elsewhere.
   */
  record(request: ValidRequest): void {
    if (!countsTowardRateLimit(request.status_code)) {
      return;
    }

    const { client_id: clientId, endpoint, timestampMs } = request;

    this.apply(`a ${clientId}`, this.policy.accountLimit(clientId), timestampMs, {
      client_id: clientId,
      scope: "account",
    });

    const endpointLimit = this.policy.endpointLimit(clientId, endpoint);
    if (endpointLimit !== undefined) {
      this.apply(`e ${clientId} ${endpoint}`, endpointLimit, timestampMs, {
        client_id: clientId,
        scope: "endpoint",
        endpoint,
      });
    }

    if (++this.recordedSinceSweep >= SWEEP_INTERVAL) {
      this.sweepIdleLimiters(timestampMs);
      this.recordedSinceSweep = 0;
    }
  }

  /** Violation events in the order they started. Call after the stream is consumed. */
  finish(): ViolationEvent[] {
    return this.events;
  }

  private apply(key: string, limit: Limit, timestampMs: number, identity: { client_id: string; scope: Scope; endpoint?: string }): void {
    let limiter = this.limiters.get(key);
    if (limiter === undefined) {
      limiter = {
        counter: new RollingWindowCounter(limit.requests, limit.windowSeconds),
        open: null,
      };
      this.limiters.set(key, limiter);
    }

    const { count, transition } = limiter.counter.record(timestampMs);

    if (transition === "start") {
      const event: ViolationEvent = {
        ...identity,
        started_at: formatTimestamp(timestampMs),
        ended_at: null,
        peak_request_count: count,
        limit: limit.requests,
        window_seconds: limit.windowSeconds,
      };
      limiter.open = event;
      this.events.push(event);
      return;
    }

    if (limiter.open !== null) {
      if (transition === "end") {
        // The window drained back to the limit as of this request's timestamp.
        limiter.open.ended_at = formatTimestamp(timestampMs);
        limiter.open = null;
      } else if (count > limiter.open.peak_request_count) {
        limiter.open.peak_request_count = count;
      }
    }
  }

  /**
   * Drops limiters whose windows have fully drained, keeping memory proportional
   * to the active windows rather than to the number of clients ever seen.
   * Limiters with a violation in progress are always kept.
   */
  private sweepIdleLimiters(now: number): void {
    for (const [key, limiter] of this.limiters) {
      if (limiter.counter.pruneIfIdle(now)) {
        this.limiters.delete(key);
      }
    }
  }
}
