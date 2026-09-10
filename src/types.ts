/** A request record as it appears on a line of the input JSONL file. */
export type RawRequest = {
  request_id: string;
  timestamp: string;
  client_id: string;
  endpoint: string;
  status_code: number;
};

/** A validated record, carrying the timestamp normalized to epoch milliseconds (UTC). */
export interface ValidRequest extends RawRequest {
  /** Epoch milliseconds. Any `+HH:MM` offset in the input has been normalized away. */
  timestampMs: number;
}

/** Result of validating a single input line. */
export type ParseResult = { ok: true; request: ValidRequest } | { ok: false; reason: string };

/** A single rate-limit ceiling: `requests` allowed per rolling `windowSeconds`. */
export type Limit = {
  requests: number;
  windowSeconds: number;
};

/** The two independent kinds of limiter. */
export type Scope = "account" | "endpoint";

/** A rate-limit violation event, as emitted in the report. */
export type ViolationEvent = {
  client_id: string;
  scope: Scope;
  /** Present only for `scope: "endpoint"`. */
  endpoint?: string;
  started_at: string;
  /** Timestamp at which the rolling window returned to <= limit; null if still violating at EOF. */
  ended_at: string | null;
  /**
   * Highest count observed in the rolling window during this event. The count at
   * the moment a violation starts is always `limit + 1` — each counted request
   * adds exactly one — so only the peak is worth reporting.
   */
  peak_request_count: number;
  limit: number;
  window_seconds: number;
};

/** The five HTTP status classes. All five always appear, so the shape is stable. */
export type StatusBucket = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";

/** Request counts per status class, e.g. `{ "2xx": 41, ... }`. */
export type StatusCounts = Record<StatusBucket, number>;

/** Requests and their status breakdown, reported for each endpoint and client. */
export type TrafficStats = {
  request_count: number;
  status_code_counts: StatusCounts;
};

export type ClientStats = TrafficStats & {
  rate_limit_violation_count: number;
};

export type EndpointStats = TrafficStats & {
  /**
   * 429s served by this endpoint, i.e. how many callers it turned away. Reported
   * separately from the `4xx` class so it can be alerted on directly.
   */
  rate_limited_count: number;
};

/** Context about the run itself, and the totals describing the input as a whole. */
export type ReportMeta = {
  /** The input path exactly as given to the CLI. */
  input_file: string;
  /** When the analysis ran, in UTC. */
  generated_at: string;
  /** Non-blank input lines encountered. */
  total_requests: number;
  valid_requests: number;
  malformed_inputs: number;
  distinct_clients: number;
  distinct_endpoints: number;
  /** Timestamps of the earliest and latest valid request; null if there were none. */
  first_request_at: string | null;
  last_request_at: string | null;
};

export type Report = {
  meta: ReportMeta;
  endpoints: Record<string, EndpointStats>;
  /** Keyed by client id, plus the reserved `"*"` entry holding the overall totals. */
  clients: Record<string, ClientStats>;
  rate_limit_violations: ViolationEvent[];
};
