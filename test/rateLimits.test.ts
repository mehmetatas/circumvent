import { describe, expect, it } from "@jest/globals";
import type { StatusBucket } from "../src/types.js";
import { analyze, at, endpointStats, line, lines, statusCounts, traffic } from "./helpers.js";

describe("rolling window", () => {
  it("does not report a violation exactly at the limit", async () => {
    const report = await analyze(lines(5));

    expect(report.rate_limit_violations).toStrictEqual([]);
    expect(report.clients.acct_1?.rate_limit_violation_count).toBe(0);
  });

  it("starts a violation on the first request over the limit", async () => {
    const report = await analyze(lines(6));

    expect(report.rate_limit_violations).toStrictEqual([
      {
        client_id: "acct_1",
        scope: "account",
        started_at: at(5),
        ended_at: null,
        peak_request_count: 6,
        limit: 5,
        window_seconds: 60,
      },
    ]);
    expect(report.clients.acct_1?.rate_limit_violation_count).toBe(1);
  });

  it("does not create extra events while the client stays over the limit", async () => {
    const report = await analyze(lines(9));

    expect(report.rate_limit_violations).toHaveLength(1);
    expect(report.rate_limit_violations[0]).toMatchObject({ peak_request_count: 9, ended_at: null });
  });

  it("ends a violation once requests expire from the window", async () => {
    // Six requests at 00:00-00:05 exceed 5/60s; by 01:10 all six have left the window.
    const report = await analyze([...lines(6), line({ timestamp: at(70) })]);

    expect(report.rate_limit_violations).toHaveLength(1);
    expect(report.rate_limit_violations[0]).toMatchObject({ started_at: at(5), ended_at: at(70) });
  });

  it("keeps a request that is exactly at the window boundary out of the window", async () => {
    // Window is (t - 60, t]: the request at 00:00 has expired by 01:00 exactly,
    // so the sixth request in the window is the one at 01:00 -> no violation.
    const report = await analyze([...lines(5), line({ timestamp: at(60) })]);

    expect(report.rate_limit_violations).toStrictEqual([]);
  });

  it("creates a new event when the limit is crossed again later", async () => {
    const report = await analyze([
      ...lines(6), // violation starts at 00:05
      line({ timestamp: at(70) }), // window drained -> violation ends
      ...lines(5, {}, 71), // 00:71-00:75, back over the limit
    ]);

    expect(report.rate_limit_violations).toHaveLength(2);
    expect(report.rate_limit_violations[0]).toMatchObject({ started_at: at(5), ended_at: at(70) });
    expect(report.rate_limit_violations[1]).toMatchObject({ started_at: at(75), peak_request_count: 6 });
    expect(report.clients.acct_1?.rate_limit_violation_count).toBe(2);
  });

  it("keeps the peak when the window shrinks but stays over the limit", async () => {
    // /v1/payments allows 2/60s. Four requests at 00:00-00:03 peak the window at 4;
    // by 01:01 the first two have expired, leaving 3 - still over, but below the peak.
    const report = await analyze([...lines(4, { endpoint: "/v1/payments" }), line({ endpoint: "/v1/payments", timestamp: at(61) })]);

    expect(report.rate_limit_violations).toHaveLength(1);
    expect(report.rate_limit_violations[0]).toMatchObject({
      scope: "endpoint",
      peak_request_count: 4,
      ended_at: null,
    });
  });

  it("treats a limit of zero as violated by the first request", async () => {
    // The config schema allows `requests: 0`, which bans the endpoint outright.
    const report = await analyze(lines(1), { defaults: { account: { requests: 0, windowSeconds: 60 } } });

    expect(report.rate_limit_violations).toMatchObject([{ scope: "account", limit: 0, peak_request_count: 1, started_at: at(0) }]);
  });

  it("tracks clients independently", async () => {
    const report = await analyze([...lines(6, { client_id: "acct_1" }), ...lines(5, { client_id: "acct_2" })]);

    expect(report.rate_limit_violations).toHaveLength(1);
    expect(report.rate_limit_violations[0]?.client_id).toBe("acct_1");
    expect(report.clients.acct_1?.rate_limit_violation_count).toBe(1);
    expect(report.clients.acct_2?.rate_limit_violation_count).toBe(0);
  });
});

describe("account and endpoint limits", () => {
  it("evaluates account and endpoint limits independently", async () => {
    // /v1/payments allows 2/60s and the account allows 5/60s, so the endpoint
    // limit is crossed at the 3rd request and the account limit at the 6th.
    const report = await analyze(lines(6, { endpoint: "/v1/payments" }));

    expect(report.rate_limit_violations.map((v) => [v.scope, v.endpoint, v.started_at, v.limit])).toStrictEqual([
      ["endpoint", "/v1/payments", at(2), 2],
      ["account", undefined, at(5), 5],
    ]);
    expect(report.clients.acct_1?.rate_limit_violation_count).toBe(2);
  });

  it("applies the default account limit", async () => {
    const report = await analyze(lines(6, { client_id: "acct_2" }));

    expect(report.rate_limit_violations[0]).toMatchObject({ limit: 5, window_seconds: 60 });
  });

  it("lets an account-specific account limit override the default", async () => {
    await expect(analyze(lines(10, { client_id: "acct_enterprise" }))).resolves.toMatchObject({ rate_limit_violations: [] });

    const over = await analyze(lines(11, { client_id: "acct_enterprise" }));

    expect(over.rate_limit_violations.filter((v) => v.scope === "account")).toMatchObject([{ limit: 10, peak_request_count: 11 }]);
  });

  it("lets an account-specific endpoint limit override the default endpoint limit", async () => {
    const client_id = "acct_enterprise";
    const endpoint = "/v1/payments";

    await expect(analyze(lines(4, { client_id, endpoint }))).resolves.toMatchObject({ rate_limit_violations: [] });

    const over = await analyze(lines(5, { client_id, endpoint }));

    expect(over.rate_limit_violations.map((v) => [v.scope, v.endpoint, v.limit, v.peak_request_count])).toStrictEqual([["endpoint", "/v1/payments", 4, 5]]);
  });

  it("gives unconfigured endpoints no endpoint limit", async () => {
    const report = await analyze(lines(6, { endpoint: "/v1/unknown" }));

    // Only the account-level limit applies to an unknown endpoint.
    expect(report.rate_limit_violations.map((v) => v.scope)).toStrictEqual(["account"]);
  });
});

describe("status codes and rate limiting", () => {
  /** The two statuses that are reported as traffic but kept out of the limiters. */
  const EXCLUDED: [label: string, status_code: number, bucket: StatusBucket][] = [
    ["429, the server's own rate-limit response", 429, "4xx"],
    ["503, a server-side failure", 503, "5xx"],
  ];

  describe.each(EXCLUDED)("%s", (_label, status_code, bucket) => {
    const input = [...lines(5, { status_code: 200 }), ...lines(4, { status_code }, 5)];

    it("is excluded from rate-limit windows", async () => {
      await expect(analyze(input)).resolves.toMatchObject({ rate_limit_violations: [] });
    });

    it("is still counted in traffic, status, endpoint and client statistics", async () => {
      const report = await analyze(input);

      expect(report.meta).toMatchObject({ total_requests: 9, valid_requests: 9 });
      expect(report.clients["*"]?.status_code_counts).toStrictEqual(statusCounts({ "2xx": 5, [bucket]: 4 }));
      // Only the 429s show up as rate-limited; the 5xxs do not.
      expect(report.endpoints).toStrictEqual({
        "/v1/widgets": endpointStats({ "2xx": 5, [bucket]: 4 }, status_code === 429 ? 4 : 0),
      });
      expect(report.clients.acct_1).toStrictEqual({
        ...traffic({ "2xx": 5, [bucket]: 4 }),
        rate_limit_violation_count: 0,
      });
    });
  });

  it("counts 3xx and non-429 4xx toward rate limits", async () => {
    const report = await analyze([
      line({ timestamp: at(0), status_code: 301 }),
      line({ timestamp: at(1), status_code: 304 }),
      line({ timestamp: at(2), status_code: 308 }),
      line({ timestamp: at(3), status_code: 404 }),
      line({ timestamp: at(4), status_code: 403 }),
      line({ timestamp: at(5), status_code: 422 }),
    ]);

    expect(report.rate_limit_violations).toHaveLength(1);
    expect(report.clients["*"]?.status_code_counts).toStrictEqual(statusCounts({ "3xx": 3, "4xx": 3 }));
  });

  it("mixes counted and uncounted statuses in one window", async () => {
    // Only the six 2xx/3xx/4xx requests reach the limiter; the 429s and 5xxs do not.
    const report = await analyze([
      line({ timestamp: at(0), status_code: 200 }),
      line({ timestamp: at(1), status_code: 500 }),
      line({ timestamp: at(2), status_code: 301 }),
      line({ timestamp: at(3), status_code: 429 }),
      line({ timestamp: at(4), status_code: 404 }),
      line({ timestamp: at(5), status_code: 503 }),
      line({ timestamp: at(6), status_code: 200 }),
      line({ timestamp: at(7), status_code: 200 }),
      line({ timestamp: at(8), status_code: 502 }),
      line({ timestamp: at(9), status_code: 200 }),
    ]);

    expect(report.meta.total_requests).toBe(10);
    expect(report.rate_limit_violations).toHaveLength(1);
    // The sixth counted request.
    expect(report.rate_limit_violations[0]?.started_at).toBe(at(9));
  });

  it("normalizes offset timestamps before applying limits", async () => {
    // The sixth request is 10:00:05Z expressed as an offset, so it is the sixth
    // request inside the window and its violation is reported in UTC.
    const report = await analyze([...lines(5), line({ timestamp: "2024-01-15T11:00:05+01:00" })]);

    expect(report.rate_limit_violations).toHaveLength(1);
    expect(report.rate_limit_violations[0]?.started_at).toBe("2024-01-15T10:00:05Z");
  });
});
