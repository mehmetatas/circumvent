import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";
import { analyzeFile } from "../src/analyze.js";
import { loadPolicy } from "../src/policy.js";
import { endpointStats, traffic } from "./helpers.js";

/**
 * The 8-line sample supplied with the exercise, kept verbatim at
 * `sample_input/requests.jsonl`. Every expectation here is countable by eye from
 * that file: `acct_1` sends six 200s to /v1/widgets between 10:00:00 and 10:00:08,
 * and `acct_2` sends two 200s to /v1/reports at 10:05:00 and 10:05:05.
 */
const PROVIDED_SAMPLE = fileURLToPath(new URL("../sample_input/requests.jsonl", import.meta.url));
const SHIPPED_POLICY = fileURLToPath(new URL("../config/rate-limits.json", import.meta.url));
const STRICT_POLICY = fileURLToPath(new URL("../config/strict-example.json", import.meta.url));

const GENERATED_AT = new Date("2026-01-02T03:04:05Z");

describe("the provided sample_input/requests.jsonl", () => {
  it("reports its traffic exactly", async () => {
    const report = await analyzeFile(PROVIDED_SAMPLE, await loadPolicy(SHIPPED_POLICY), GENERATED_AT);

    expect(report.meta).toStrictEqual({
      input_file: PROVIDED_SAMPLE,
      generated_at: "2026-01-02T03:04:05Z",
      total_requests: 8,
      valid_requests: 8,
      malformed_inputs: 0,
      distinct_clients: 2,
      distinct_endpoints: 2,
      first_request_at: "2024-01-15T10:00:00Z",
      last_request_at: "2024-01-15T10:05:05Z",
    });
    expect(report.endpoints).toStrictEqual({
      "/v1/reports": endpointStats({ "2xx": 2 }),
      "/v1/widgets": endpointStats({ "2xx": 6 }),
    });
    expect(report.clients).toStrictEqual({
      "*": { ...traffic({ "2xx": 8 }), rate_limit_violation_count: 0 },
      acct_1: { ...traffic({ "2xx": 6 }), rate_limit_violation_count: 0 },
      acct_2: { ...traffic({ "2xx": 2 }), rate_limit_violation_count: 0 },
    });
  });

  it("finds no violations under the shipped policy, because there are none", async () => {
    // Six requests in nine seconds is ~40/min sustained, comfortably inside the
    // shipped 100/60s limit for /v1/widgets and the 1000/60s account limit. An
    // empty list here is the correct answer, not a missing feature.
    const report = await analyzeFile(PROVIDED_SAMPLE, await loadPolicy(SHIPPED_POLICY), GENERATED_AT);

    expect(report.rate_limit_violations).toStrictEqual([]);
  });

  it("flags acct_1 under the stricter demo policy, on the sixth request", async () => {
    // config/strict-example.json caps /v1/widgets at 5/60s, so the 6th request at
    // 10:00:08 crosses it. This is the same file and the same code: only policy moved.
    const report = await analyzeFile(PROVIDED_SAMPLE, await loadPolicy(STRICT_POLICY), GENERATED_AT);

    expect(report.rate_limit_violations).toStrictEqual([
      {
        client_id: "acct_1",
        scope: "endpoint",
        endpoint: "/v1/widgets",
        started_at: "2024-01-15T10:00:08Z",
        ended_at: null,
        peak_request_count: 6,
        limit: 5,
        window_seconds: 60,
      },
    ]);
    expect(report.clients.acct_1?.rate_limit_violation_count).toBe(1);
    // acct_2 sits exactly at the 2/60s reports limit, which is not a violation.
    expect(report.clients.acct_2?.rate_limit_violation_count).toBe(0);
  });
});
