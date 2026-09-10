import { describe, expect, it } from "@jest/globals";
import { parseLine } from "../src/parser.js";
import { formatTimestamp, parseTimestamp } from "../src/timestamps.js";
import { analyze, at, line, meta, statusCounts } from "./helpers.js";

describe("validation", () => {
  it("accepts a well-formed record", () => {
    const result = parseLine('{"request_id":"a1_1","timestamp":"2024-01-15T10:00:00Z","client_id":"acct_1","endpoint":"/v1/widgets","status_code":200}');

    expect(result.ok).toBe(true);
    expect(result.ok && result.request).toStrictEqual({
      request_id: "a1_1",
      timestamp: "2024-01-15T10:00:00Z",
      client_id: "acct_1",
      endpoint: "/v1/widgets",
      status_code: 200,
      timestampMs: Date.parse("2024-01-15T10:00:00Z"),
    });
  });

  it.each(["{", "not json", '{"request_id":}', "[1,2,3]", '"a string"', "null"])("rejects malformed JSON: %s", (bad) => {
    expect(parseLine(bad).ok).toBe(false);
  });

  it.each(["request_id", "timestamp", "client_id", "endpoint", "status_code"])("rejects a record missing %s", (field) => {
    const record = JSON.parse(line()) as Record<string, unknown>;
    delete record[field];

    const result = parseLine(JSON.stringify(record));

    expect(result.ok).toBe(false);
    expect(!result.ok ? result.reason : "").toMatch(/missing field/);
  });

  it.each([
    { client_id: 42 },
    { client_id: "" },
    { endpoint: null },
    { endpoint: ["/v1/widgets"] },
    { request_id: { id: 1 } },
    { timestamp: 1705312800 },
    { status_code: "200" },
    { status_code: 200.5 },
    { status_code: null },
  ])("rejects invalid field types: %j", (overrides) => {
    expect(parseLine(line(overrides)).ok).toBe(false);
  });

  it.each([
    "",
    "yesterday",
    "2024-01-15",
    "2024-01-15T10:00:00",
    "2024-13-15T10:00:00Z",
    "2024-01-32T10:00:00Z",
    "2024-01-15T25:00:00Z",
    "2024-01-15T10:00:00+0100",
    "Jan 15 2024 10:00:00 UTC",
  ])("rejects the invalid timestamp %p", (timestamp) => {
    expect(parseTimestamp(timestamp)).toBeNull();
    expect(parseLine(line({ timestamp })).ok).toBe(false);
  });

  it.each([{ status_code: true }, { status_code: [] }, { client_id: false }, { timestamp: {} }])("rejects a non-string/non-number field: %j", (overrides) => {
    expect(parseLine(line(overrides)).ok).toBe(false);
  });

  it.each(["request_id", "timestamp", "client_id", "endpoint"])("rejects an empty %s", (field) => {
    const result = parseLine(line({ [field]: "" }));

    expect(result.ok).toBe(false);
    expect(!result.ok ? result.reason : "").toMatch(/must be a non-empty string/);
  });

  it("ignores fields it does not know about", () => {
    // The schema has no HTTP method (see the README's product gaps); an event that
    // carries extra fields is still a valid record, and they are simply dropped.
    const result = parseLine(line({ method: "POST", region: "eu-west-1", latency_ms: 12 }));

    expect(result.ok).toBe(true);
    expect(result.ok && Object.keys(result.request).sort()).toStrictEqual(["client_id", "endpoint", "request_id", "status_code", "timestamp", "timestampMs"]);
  });

  it.each([0, 99, 600, 1000, -200])("rejects the out-of-range status code %i", (status_code) => {
    expect(parseLine(line({ status_code })).ok).toBe(false);
  });

  it.each([100, 200, 429, 599])("accepts the status code %i", (status_code) => {
    expect(parseLine(line({ status_code })).ok).toBe(true);
  });

  it.each([
    ["a lowercase separator and zone", "2024-01-15t10:00:00z"],
    ["a space separator", "2024-01-15 10:00:00Z"],
    ["fractional seconds", "2024-01-15T10:00:00.000Z"],
    ["a +00:00 offset", "2024-01-15T10:00:00+00:00"],
    ["a -00:00 offset", "2024-01-15T10:00:00-00:00"],
  ])("accepts RFC 3339 written with %s", (_label, timestamp) => {
    expect(parseTimestamp(timestamp)).toBe(Date.parse("2024-01-15T10:00:00Z"));
  });

  it("truncates sub-millisecond precision rather than rejecting it", () => {
    expect(parseTimestamp("2024-01-15T10:00:00.123456Z")).toBe(Date.parse("2024-01-15T10:00:00.123Z"));
  });

  it("rejects a leap second, which Date cannot represent", () => {
    expect(parseTimestamp("2024-01-15T10:00:60Z")).toBeNull();
  });

  it("normalizes timestamp offsets to UTC", () => {
    const utc = parseTimestamp("2024-01-15T10:00:00Z") as number;

    expect(parseTimestamp("2024-01-15T11:00:00+01:00")).toBe(utc);
    expect(parseTimestamp("2024-01-15T05:30:00-04:30")).toBe(utc);
    expect(parseTimestamp("2024-01-15T10:00:00.000Z")).toBe(utc);
    expect(formatTimestamp(utc)).toBe("2024-01-15T10:00:00Z");
    expect(formatTimestamp(utc + 250)).toBe("2024-01-15T10:00:00.250Z");
  });
});

describe("stream-level validation", () => {
  it("reports zeroed counts for empty input", async () => {
    await expect(analyze([])).resolves.toStrictEqual({
      meta: meta(),
      endpoints: {},
      // The reserved totals entry is always present, even with nothing to total.
      clients: { "*": { request_count: 0, status_code_counts: statusCounts({}), rate_limit_violation_count: 0 } },
      rate_limit_violations: [],
    });
  });

  it("ignores blank lines", async () => {
    const report = await analyze(["", "   ", line(), ""]);

    expect(report.meta.total_requests).toBe(1);
    expect(report.meta.malformed_inputs).toBe(0);
  });

  it("keeps processing after malformed lines", async () => {
    const report = await analyze([
      line({ timestamp: at(0) }),
      "{ this is not json",
      line({ timestamp: at(1) }),
      JSON.stringify({ request_id: "x", timestamp: at(2), client_id: "acct_1" }),
      line({ timestamp: at(3), status_code: 999 }),
      line({ timestamp: at(4) }),
    ]);

    expect(report.meta).toMatchObject({ total_requests: 6, valid_requests: 3, malformed_inputs: 3 });
    expect(report.clients.acct_1?.request_count).toBe(3);
    expect(report.rate_limit_violations).toStrictEqual([]);
  });
});
