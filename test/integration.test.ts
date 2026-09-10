import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";
import { analyzeFile } from "../src/analyze.js";
import { loadPolicy } from "../src/policy.js";
import type { ClientStats, EndpointStats, Report, ReportMeta, StatusBucket, TrafficStats, ViolationEvent } from "../src/types.js";
import { runCli } from "./helpers.js";

const SAMPLE_INPUT = fileURLToPath(new URL("./integration.jsonl", import.meta.url));
const SHIPPED_CONFIG = fileURLToPath(new URL("../config/rate-limits.json", import.meta.url));

/** Pinned so the whole report, `meta` included, is reproducible. */
const GENERATED_AT = new Date("2026-01-02T03:04:05Z");

const BUCKETS = ["1xx", "2xx", "3xx", "4xx", "5xx"] as const satisfies readonly StatusBucket[];

/**
 * `test/integration.jsonl` is a ~1 MB log (7762 lines) built from a handful of
 * deliberately planted scenarios plus background traffic that stays well inside
 * every limit. The expectations below were computed independently of the
 * analyzer, and each planted scenario pins one behaviour:
 *
 * - `acct_reports` sends 12 requests to /v1/reports (10/60s), so it crosses the
 *   limit on the 11th and peaks at 12. Two 429s follow and are ignored by the
 *   window. Much later it sends 11 more, which drains the first event and opens a
 *   second one that is still open at end of input.
 * - `acct_payments` sends 21 requests to /v1/payments, crossing the default
 *   20/60s limit exactly once.
 * - `acct_enterprise` sends 60 requests to /v1/payments and does **not** violate:
 *   its account-specific override raises that endpoint to 100/60s.
 * - `acct_degraded` sends 40 requests that are all 429 or 5xx, and violates
 *   nothing at all — neither status reaches a limiter.
 * - `acct_explorer` sends 30 requests to the unconfigured /v1/experimental, which
 *   has no endpoint limit and stays far under the account limit.
 * - `acct_offsets` sends timestamps with `+02:00` and `-05:00` offsets.
 * - Seven lines are malformed: a bad timestamp, a truncated object, a missing
 *   `client_id`, a non-JSON line, an out-of-range status, a fractional status, and
 *   a JSON array. Two of them carry a `client_id` that appears nowhere else, so
 *   `distinct_clients` proves discarded lines contribute nothing.
 */
const EXPECTED_META: ReportMeta = {
  input_file: SAMPLE_INPUT,
  generated_at: "2026-01-02T03:04:05Z",
  total_requests: 7762,
  valid_requests: 7755,
  malformed_inputs: 7,
  distinct_clients: 126,
  distinct_endpoints: 7,
  first_request_at: "2024-01-15T10:00:10Z",
  last_request_at: "2024-01-15T10:27:26Z",
};

/** The reserved `"*"` entry: totals over every client. */
const EXPECTED_OVERALL: ClientStats = {
  request_count: 7755,
  status_code_counts: { "1xx": 0, "2xx": 5914, "3xx": 429, "4xx": 951, "5xx": 461 },
  rate_limit_violation_count: 3,
};

const EXPECTED_ENDPOINTS: Record<string, EndpointStats> = {
  "/v1/experimental": {
    request_count: 30,
    status_code_counts: { "1xx": 0, "2xx": 24, "3xx": 0, "4xx": 6, "5xx": 0 },
    rate_limited_count: 0,
  },
  "/v1/invoices": {
    request_count: 1257,
    status_code_counts: { "1xx": 0, "2xx": 950, "3xx": 70, "4xx": 170, "5xx": 67 },
    rate_limited_count: 45,
  },
  "/v1/payments": {
    request_count: 1355,
    status_code_counts: { "1xx": 0, "2xx": 1035, "3xx": 68, "4xx": 182, "5xx": 70 },
    rate_limited_count: 62,
  },
  "/v1/reports": {
    request_count: 1285,
    status_code_counts: { "1xx": 0, "2xx": 975, "3xx": 79, "4xx": 151, "5xx": 80 },
    rate_limited_count: 39,
  },
  "/v1/search": {
    request_count: 1318,
    status_code_counts: { "1xx": 0, "2xx": 1024, "3xx": 75, "4xx": 157, "5xx": 62 },
    rate_limited_count: 29,
  },
  "/v1/users": {
    request_count: 1261,
    status_code_counts: { "1xx": 0, "2xx": 950, "3xx": 72, "4xx": 147, "5xx": 92 },
    rate_limited_count: 42,
  },
  "/v1/widgets": {
    request_count: 1249,
    status_code_counts: { "1xx": 0, "2xx": 956, "3xx": 65, "4xx": 138, "5xx": 90 },
    rate_limited_count: 59,
  },
};

/** The planted clients; the 120 background accounts are covered by the totals. */
const EXPECTED_PLANTED_CLIENTS: Record<string, ClientStats> = {
  acct_degraded: {
    request_count: 40,
    status_code_counts: { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 20, "5xx": 20 },
    rate_limit_violation_count: 0,
  },
  acct_enterprise: {
    request_count: 60,
    status_code_counts: { "1xx": 0, "2xx": 60, "3xx": 0, "4xx": 0, "5xx": 0 },
    rate_limit_violation_count: 0,
  },
  acct_explorer: {
    request_count: 30,
    status_code_counts: { "1xx": 0, "2xx": 24, "3xx": 0, "4xx": 6, "5xx": 0 },
    rate_limit_violation_count: 0,
  },
  acct_offsets: {
    request_count: 3,
    status_code_counts: { "1xx": 0, "2xx": 2, "3xx": 1, "4xx": 0, "5xx": 0 },
    rate_limit_violation_count: 0,
  },
  acct_payments: {
    request_count: 21,
    status_code_counts: { "1xx": 0, "2xx": 21, "3xx": 0, "4xx": 0, "5xx": 0 },
    rate_limit_violation_count: 1,
  },
  acct_reports: {
    request_count: 25,
    status_code_counts: { "1xx": 0, "2xx": 23, "3xx": 0, "4xx": 2, "5xx": 0 },
    rate_limit_violation_count: 2,
  },
};

const EXPECTED_VIOLATIONS: ViolationEvent[] = [
  {
    client_id: "acct_reports",
    scope: "endpoint",
    endpoint: "/v1/reports",
    started_at: "2024-01-15T10:00:20Z",
    ended_at: "2024-01-15T10:03:20Z",
    peak_request_count: 12,
    limit: 10,
    window_seconds: 60,
  },
  {
    client_id: "acct_reports",
    scope: "endpoint",
    endpoint: "/v1/reports",
    started_at: "2024-01-15T10:03:30Z",
    ended_at: null,
    peak_request_count: 11,
    limit: 10,
    window_seconds: 60,
  },
  {
    client_id: "acct_payments",
    scope: "endpoint",
    endpoint: "/v1/payments",
    started_at: "2024-01-15T10:05:20Z",
    ended_at: null,
    peak_request_count: 21,
    limit: 20,
    window_seconds: 60,
  },
];

const analyzeSample = async (): Promise<Report> => analyzeFile(SAMPLE_INPUT, await loadPolicy(SHIPPED_CONFIG), GENERATED_AT);

const sumStatuses = (stats: TrafficStats): number => BUCKETS.reduce((sum, bucket) => sum + stats.status_code_counts[bucket], 0);

describe("integration: test/integration.jsonl", () => {
  it("reports the run metadata", async () => {
    expect((await analyzeSample()).meta).toStrictEqual(EXPECTED_META);
  });

  it("totals every client under the reserved * entry", async () => {
    expect((await analyzeSample()).clients["*"]).toStrictEqual(EXPECTED_OVERALL);
  });

  it("breaks every endpoint down by status, counting 429s separately", async () => {
    expect((await analyzeSample()).endpoints).toStrictEqual(EXPECTED_ENDPOINTS);
  });

  it("reports the planted clients exactly", async () => {
    const { clients } = await analyzeSample();
    const planted = Object.fromEntries(Object.entries(clients).filter(([id]) => id in EXPECTED_PLANTED_CLIENTS));

    expect(planted).toStrictEqual(EXPECTED_PLANTED_CLIENTS);
  });

  it("finds only the planted violations", async () => {
    expect((await analyzeSample()).rate_limit_violations).toStrictEqual(EXPECTED_VIOLATIONS);
  });

  it("never starts a violation below limit + 1", async () => {
    // Each counted request adds exactly one, so a window can only cross its limit
    // by one; the peak is therefore never at or below the limit.
    const peaks = (await analyzeSample()).rate_limit_violations.map((v) => [v.client_id, v.peak_request_count > v.limit] as const);

    expect(peaks).toStrictEqual(peaks.map(([clientId]) => [clientId, true]));
  });

  // Endpoints and clients are two partitions of the same valid requests, so each
  // must sum to valid_requests and to the overall status counts, class by class.
  describe.each(["endpoint", "client"] as const)("the %s breakdown", (dimension) => {
    const entriesOf = (report: Report): [string, TrafficStats][] =>
      dimension === "endpoint" ? Object.entries(report.endpoints) : Object.entries(report.clients).filter(([id]) => id !== "*");

    it("has status counts that sum to each request_count", async () => {
      const entries = entriesOf(await analyzeSample());
      const summed = entries.map(([key, stats]) => [key, sumStatuses(stats)]);

      expect(summed).toStrictEqual(entries.map(([key, stats]) => [key, stats.request_count]));
    });

    it("covers every valid request", async () => {
      const report = await analyzeSample();
      const total = entriesOf(report).reduce((sum, [, stats]) => sum + stats.request_count, 0);

      expect(total).toBe(report.meta.valid_requests);
    });

    it("agrees with the overall status counts class by class", async () => {
      const report = await analyzeSample();
      const entries = entriesOf(report);
      const summed = Object.fromEntries(BUCKETS.map((bucket) => [bucket, entries.reduce((sum, [, s]) => sum + s.status_code_counts[bucket], 0)]));

      expect(summed).toStrictEqual(report.clients["*"]?.status_code_counts);
    });
  });

  it("counts each endpoint's 429s as a subset of its 4xx", async () => {
    const endpoints = Object.entries((await analyzeSample()).endpoints);
    const withinFourXx = endpoints.map(([path, s]) => [path, s.rate_limited_count <= s.status_code_counts["4xx"]] as const);

    expect(withinFourXx).toStrictEqual(endpoints.map(([path]) => [path, true]));
    expect(endpoints.reduce((sum, [, s]) => sum + s.rate_limited_count, 0)).toBeGreaterThan(0);
  });

  it("produces the same report through the CLI, with nothing else on stdout", async () => {
    const before = Date.now();
    const { stdout, stderr, code } = await runCli([SAMPLE_INPUT]);

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const { meta, ...rest } = JSON.parse(stdout) as Report;
    const expected = await analyzeSample();

    // Everything but the run timestamp is reproducible.
    expect({ ...meta, generated_at: EXPECTED_META.generated_at }).toStrictEqual(EXPECTED_META);
    expect(rest).toStrictEqual({
      endpoints: expected.endpoints,
      clients: expected.clients,
      rate_limit_violations: expected.rate_limit_violations,
    });

    // generated_at is the time of the run.
    const generatedAt = Date.parse(meta.generated_at);
    expect(generatedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(generatedAt).toBeLessThanOrEqual(Date.now());
  });

  it("keeps the sorted, deterministic key order in the JSON output", async () => {
    const { stdout } = await runCli([SAMPLE_INPUT]);
    const parsed = JSON.parse(stdout) as Report;

    expect(Object.keys(parsed.endpoints)).toStrictEqual(Object.keys(EXPECTED_ENDPOINTS));

    const clientIds = Object.keys(parsed.clients);
    expect(clientIds[0]).toBe("*");
    expect(clientIds.slice(1)).toStrictEqual([...clientIds.slice(1)].sort());
    expect(Object.keys(parsed.clients["*"]?.status_code_counts ?? {})).toStrictEqual([...BUCKETS]);
    expect(Object.keys(parsed.endpoints["/v1/widgets"]?.status_code_counts ?? {})).toStrictEqual([...BUCKETS]);
  });
});
