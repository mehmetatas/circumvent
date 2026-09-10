import { describe, expect, it } from "@jest/globals";
import { analyzeFile } from "../src/analyze.js";
import { createPolicy } from "../src/policy.js";
import { analyze, at, line, lines, TEST_CONFIG, writeInput } from "./helpers.js";

describe("analyzeFile", () => {
  it("reads the file it is given and stamps the run with the current time", async () => {
    const before = Date.now();
    const path = await writeInput(lines(3).join("\n") + "\n");

    // No `generatedAt` argument: it defaults to now.
    const report = await analyzeFile(path, createPolicy(TEST_CONFIG));

    expect(report.meta.input_file).toBe(path);
    expect(report.meta.valid_requests).toBe(3);
    const generatedAt = Date.parse(report.meta.generated_at);
    expect(generatedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(generatedAt).toBeLessThanOrEqual(Date.now());
  });

  it("rejects when the file does not exist", async () => {
    await expect(analyzeFile("./no-such-file.jsonl", createPolicy(TEST_CONFIG))).rejects.toThrow(/ENOENT/);
  });
});

describe("file quirks", () => {
  it("reads a file with CRLF line endings", async () => {
    const path = await writeInput(lines(3).join("\r\n") + "\r\n");

    const report = await analyzeFile(path, createPolicy(TEST_CONFIG));

    expect(report.meta).toMatchObject({ total_requests: 3, valid_requests: 3, malformed_inputs: 0 });
  });

  it("strips a leading byte-order mark instead of losing the first record", async () => {
    const path = await writeInput(`\uFEFF${lines(3).join("\n")}\n`);

    const report = await analyzeFile(path, createPolicy(TEST_CONFIG));

    expect(report.meta).toMatchObject({ total_requests: 3, valid_requests: 3, malformed_inputs: 0 });
  });

  it("reads a file whose last line has no trailing newline", async () => {
    const path = await writeInput(lines(3).join("\n"));

    await expect(analyzeFile(path, createPolicy(TEST_CONFIG))).resolves.toMatchObject({
      meta: expect.objectContaining({ valid_requests: 3 }),
    });
  });
});

describe("report shaping", () => {
  it("reports no time range when every line is malformed", async () => {
    const report = await analyze(["not json", '{"request_id":"x"}', "[]"]);

    expect(report.meta).toMatchObject({
      total_requests: 3,
      valid_requests: 0,
      malformed_inputs: 3,
      distinct_clients: 0,
      distinct_endpoints: 0,
      first_request_at: null,
      last_request_at: null,
    });
    expect(report.endpoints).toStrictEqual({});
    expect(report.clients["*"]?.request_count).toBe(0);
  });

  it("keeps the totals when a client is literally named *", async () => {
    // `*` is reserved for the totals, so such a client gets no row of its own.
    const report = await analyze([...lines(2, { client_id: "*" }), ...lines(3, { client_id: "acct_1" }, 2)]);

    expect(report.clients["*"]?.request_count).toBe(5);
    expect(report.clients.acct_1?.request_count).toBe(3);
    expect(Object.keys(report.clients)).toStrictEqual(["*", "acct_1"]);
    expect(report.meta.distinct_clients).toBe(2);
  });

  it("reports the time range spanned by the valid requests only", async () => {
    const report = await analyze([
      line({ timestamp: at(50) }),
      line({ timestamp: "not-a-timestamp" }),
      line({ timestamp: at(10) }),
      line({ timestamp: at(30) }),
    ]);

    expect(report.meta).toMatchObject({
      first_request_at: at(10),
      last_request_at: at(50),
      malformed_inputs: 1,
    });
  });
});

describe("out-of-order input", () => {
  it("distorts the window when a record arrives well out of order", async () => {
    // Documents the cost of the chronological assumption (see the README). The
    // rolling window only evicts from the head, so a much older timestamp appended
    // at the tail evicts nothing: the count then spans more than the window and
    // reports a violation that never really happened, stamped with the old time.
    const report = await analyze([...lines(5), line({ timestamp: "2024-01-15T09:00:00Z" })]);

    expect(report.rate_limit_violations).toMatchObject([{ scope: "account", started_at: "2024-01-15T09:00:00Z", peak_request_count: 6 }]);
    // Traffic statistics are unaffected, and the range still covers the log.
    expect(report.meta).toMatchObject({
      valid_requests: 6,
      first_request_at: "2024-01-15T09:00:00Z",
      last_request_at: at(4),
    });
  });
});

describe("idle limiter sweep", () => {
  it("stays correct across the sweep that discards drained limiters", async () => {
    // The sweep runs every 10_000 counted requests. This drives 10_050 requests
    // from short-lived clients past that point, then has one client breach a
    // limit afterwards, so a dropped limiter cannot go unnoticed.
    const background = Array.from({ length: 10_050 }, (_, i) => line({ client_id: `acct_bg_${i}`, timestamp: at(i) }));
    const breach = lines(6, { client_id: "acct_late" }, 20_000);

    const report = await analyze([...background, ...breach]);

    expect(report.meta.valid_requests).toBe(10_056);
    expect(report.meta.distinct_clients).toBe(10_051);
    expect(report.rate_limit_violations).toMatchObject([{ client_id: "acct_late", scope: "account", limit: 5, peak_request_count: 6 }]);
  });
});
