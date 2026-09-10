import { formatTimestamp } from "./timestamps.js";
import type { ClientStats, EndpointStats, Report, ReportMeta, StatusBucket, StatusCounts, TrafficStats, ValidRequest, ViolationEvent } from "./types.js";

/**
 * `200 -> "2xx"`, `503 -> "5xx"`. Validation has already rejected anything
 * outside 100-599, so the result is always one of the five known buckets.
 */
const statusBucket = (statusCode: number): StatusBucket => `${Math.floor(statusCode / 100)}xx` as StatusBucket;

/** Reserved `clients` key holding the totals across every client. */
export const ALL_CLIENTS = "*";

const TOO_MANY_REQUESTS = 429;

/** A fresh set of status-class counters, one per class, all starting at zero. */
const emptyStatusCounts = (): StatusCounts => ({ "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 });

/** Running counters for one endpoint or one client. */
type Counters = {
  requests: number;
  statuses: StatusCounts;
  /** 429s only; used for the per-endpoint rate-limited count. */
  rateLimited: number;
};

const emptyCounters = (): Counters => ({ requests: 0, statuses: emptyStatusCounts(), rateLimited: 0 });

/** Counts one request against a keyed set of counters, creating it on first sight. */
const countRequest = (counters: Map<string, Counters>, key: string, statusCode: number): void => {
  let entry = counters.get(key);
  if (entry === undefined) {
    entry = emptyCounters();
    counters.set(key, entry);
  }
  entry.requests++;
  entry.statuses[statusBucket(statusCode)]++;
  if (statusCode === TOO_MANY_REQUESTS) {
    entry.rateLimited++;
  }
};

const toStats = ({ requests, statuses }: Counters): TrafficStats => ({
  request_count: requests,
  status_code_counts: statuses,
});

const toEndpointStats = (counters: Counters): EndpointStats => ({
  ...toStats(counters),
  rate_limited_count: counters.rateLimited,
});

/** What the analyzer knows about the run, as opposed to the traffic in it. */
export type RunContext = {
  /** The input path as given on the command line. */
  inputFile: string;
  /** When the run started. Injected so a report can be reproduced exactly. */
  generatedAt: Date;
};

/**
 * Accumulates traffic statistics over the valid requests in the stream.
 *
 * Every valid request is counted here, including the 429s and 5xx that are
 * excluded from the rate-limit windows. Memory is proportional to the number of
 * distinct clients and endpoints, not to the number of requests.
 */
export class TrafficAggregator {
  private totalLines = 0;
  private validRequests = 0;
  private malformedInputs = 0;
  private readonly statusCounts = emptyStatusCounts();
  private readonly endpoints = new Map<string, Counters>();
  private readonly clients = new Map<string, Counters>();
  private firstRequestMs: number | null = null;
  private lastRequestMs: number | null = null;

  constructor(private readonly context: RunContext) {}

  /** Counts an input line that could not be parsed or validated. */
  addMalformed(): void {
    this.totalLines++;
    this.malformedInputs++;
  }

  /** Counts a valid request toward the traffic statistics. */
  add(request: ValidRequest): void {
    this.totalLines++;
    this.validRequests++;

    if (this.firstRequestMs === null || request.timestampMs < this.firstRequestMs) {
      this.firstRequestMs = request.timestampMs;
    }
    if (this.lastRequestMs === null || request.timestampMs > this.lastRequestMs) {
      this.lastRequestMs = request.timestampMs;
    }

    this.statusCounts[statusBucket(request.status_code)]++;
    countRequest(this.endpoints, request.endpoint, request.status_code);
    countRequest(this.clients, request.client_id, request.status_code);
  }

  /**
   * Combines the traffic statistics with the violation events into the final
   * report. Object keys are sorted so the output is deterministic.
   */
  build(violations: ViolationEvent[]): Report {
    const violationsPerClient = new Map<string, number>();
    for (const violation of violations) {
      increment(violationsPerClient, violation.client_id);
    }

    // The overall totals ride along as a reserved client entry, listed first.
    const clients: Record<string, ClientStats> = {
      [ALL_CLIENTS]: {
        request_count: this.validRequests,
        status_code_counts: this.statusCounts,
        rate_limit_violation_count: violations.length,
      },
    };
    for (const [clientId, counters] of sortedEntries(this.clients)) {
      // `"*"` is reserved for the totals; a client literally named `*` cannot have
      // its own row without shadowing them. Account ids are not expected to be `*`.
      if (clientId === ALL_CLIENTS) {
        continue;
      }
      clients[clientId] = {
        ...toStats(counters),
        rate_limit_violation_count: violationsPerClient.get(clientId) ?? 0,
      };
    }

    const endpoints: Record<string, EndpointStats> = {};
    for (const [endpoint, counters] of sortedEntries(this.endpoints)) {
      endpoints[endpoint] = toEndpointStats(counters);
    }

    return {
      meta: this.buildMeta(),
      endpoints,
      clients,
      rate_limit_violations: violations,
    };
  }

  private buildMeta(): ReportMeta {
    return {
      input_file: this.context.inputFile,
      generated_at: formatTimestamp(this.context.generatedAt.getTime()),
      total_requests: this.totalLines,
      valid_requests: this.validRequests,
      malformed_inputs: this.malformedInputs,
      distinct_clients: this.clients.size,
      distinct_endpoints: this.endpoints.size,
      first_request_at: this.firstRequestMs === null ? null : formatTimestamp(this.firstRequestMs),
      last_request_at: this.lastRequestMs === null ? null : formatTimestamp(this.lastRequestMs),
    };
  }
}

const increment = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

/** Entries ordered by key (code-unit order). Map keys are unique, so no tie case. */
const sortedEntries = <T>(map: Map<string, T>): [string, T][] => [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
