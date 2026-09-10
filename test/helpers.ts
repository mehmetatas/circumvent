import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { analyzeLines } from "../src/analyze.js";
import { createPolicy } from "../src/policy.js";
import { formatTimestamp } from "../src/timestamps.js";
import type { EndpointStats, Report, ReportMeta, StatusBucket, StatusCounts, TrafficStats } from "../src/types.js";

/**
 * Test policy with deliberately tiny limits so the expected behaviour of each
 * test is obvious:
 *   - every account: 5 requests / 60s
 *   - /v1/payments: 2 requests / 60s
 *   - acct_enterprise: 10 requests / 60s, and 4 / 60s on /v1/payments
 *   - /v1/unknown is not configured, so it has no endpoint limit
 */
export const TEST_CONFIG = {
  defaults: {
    account: { requests: 5, windowSeconds: 60 },
    endpoints: {
      "/v1/payments": { requests: 2, windowSeconds: 60 },
    },
  },
  accounts: {
    acct_enterprise: {
      account: { requests: 10, windowSeconds: 60 },
      endpoints: {
        "/v1/payments": { requests: 4, windowSeconds: 60 },
      },
    },
  },
};

/**
 * Expected status-class counts: the classes given, with the rest at zero. The
 * report always carries all five, so unit tests only spell out the ones in play
 * (`test/integration.test.ts` asserts the full literal shape).
 */
export const statusCounts = (present: Partial<Record<StatusBucket, number>>): StatusCounts => ({
  "1xx": 0,
  "2xx": 0,
  "3xx": 0,
  "4xx": 0,
  "5xx": 0,
  ...present,
});

/** Fixed run context, so unit tests see a deterministic `meta` block. */
export const RUN_CONTEXT = { inputFile: "<memory>", generatedAt: new Date("2026-01-02T03:04:05Z") };

/** Expected `meta`, with only the fields a test cares about spelled out. */
export const meta = (present: Partial<ReportMeta> = {}): ReportMeta => ({
  input_file: RUN_CONTEXT.inputFile,
  generated_at: formatTimestamp(RUN_CONTEXT.generatedAt.getTime()),
  total_requests: 0,
  valid_requests: 0,
  malformed_inputs: 0,
  distinct_clients: 0,
  distinct_endpoints: 0,
  first_request_at: null,
  last_request_at: null,
  ...present,
});

/**
 * Expected traffic stats for an endpoint or client: the status classes given,
 * with `request_count` as their sum.
 */
export const traffic = (present: Partial<Record<StatusBucket, number>>): TrafficStats => ({
  request_count: Object.values(present).reduce((sum, n) => sum + (n ?? 0), 0),
  status_code_counts: statusCounts(present),
});

/** Expected endpoint stats: traffic plus the count of 429s it served. */
export const endpointStats = (present: Partial<Record<StatusBucket, number>>, rateLimited = 0): EndpointStats => ({
  ...traffic(present),
  rate_limited_count: rateLimited,
});

const BASE_MS = Date.parse("2024-01-15T10:00:00Z");

/** `at(5)` is 5 seconds after 2024-01-15T10:00:00Z, as a `Z` timestamp. */
export const at = (seconds: number): string => new Date(BASE_MS + seconds * 1000).toISOString().replace(".000Z", "Z");

let sequence = 0;

/** Builds one JSONL line, defaulting everything the test does not care about. */
export const line = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    request_id: `req_${++sequence}`,
    timestamp: at(0),
    client_id: "acct_1",
    endpoint: "/v1/widgets",
    status_code: 200,
    ...overrides,
  });

/** Builds `count` lines one second apart, starting at `at(startSecond)`. */
export const lines = (count: number, overrides: Record<string, unknown> = {}, startSecond = 0): string[] =>
  Array.from({ length: count }, (_, i) => line({ timestamp: at(startSecond + i), ...overrides }));

/** Runs the analyzer over in-memory lines using the test policy by default. */
export const analyze = async (input: string[], config: unknown = TEST_CONFIG): Promise<Report> => analyzeLines(input, createPolicy(config), RUN_CONTEXT);

const execFileAsync = promisify(execFile);
const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Runs the CLI the way `npm run analyze` does, returning stdout, stderr and exit code. */
export const runCli = async (args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", ENTRY, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout: string; stderr: string; code: number };
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
  }
};

/** Writes `content` to a throwaway file and returns its path. */
export const writeInput = async (content: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "api-traffic-"));
  const path = join(dir, "input.jsonl");
  await writeFile(path, content, "utf8");
  return path;
};
