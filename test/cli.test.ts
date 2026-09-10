import { describe, expect, it } from "@jest/globals";
import type { Report } from "../src/types.js";
import { at, endpointStats, line, lines, runCli, statusCounts, writeInput } from "./helpers.js";

describe("cli", () => {
  it("writes exactly one JSON report to stdout and nothing else", async () => {
    const input = await writeInput(
      [
        ...lines(3, { endpoint: "/v1/widgets" }),
        "not json at all",
        ...lines(21, { endpoint: "/v1/payments" }, 10), // default policy allows 20/60s
        line({ timestamp: at(40), status_code: 429, endpoint: "/v1/payments" }),
      ].join("\n") + "\n",
    );

    const { stdout, stderr, code } = await runCli([input]);

    expect(code).toBe(0);
    expect(stderr).toBe("");

    // Parsing succeeds only if stdout holds a single JSON document and no logs.
    const report = JSON.parse(stdout) as Report;
    expect(report.meta).toMatchObject({ total_requests: 26, valid_requests: 25, malformed_inputs: 1 });
    expect(report.endpoints).toStrictEqual({
      // The 21 accepted payments requests plus the one that was rejected with 429.
      "/v1/payments": endpointStats({ "2xx": 21, "4xx": 1 }, 1),
      "/v1/widgets": endpointStats({ "2xx": 3 }),
    });
    expect(report.clients["*"]?.status_code_counts).toStrictEqual(statusCounts({ "2xx": 24, "4xx": 1 }));

    // The shipped policy: /v1/payments is 20/60s for a default account.
    expect(report.rate_limit_violations.map((v) => [v.scope, v.endpoint, v.limit, v.peak_request_count])).toStrictEqual([["endpoint", "/v1/payments", 20, 21]]);
    expect(report.clients.acct_1?.rate_limit_violation_count).toBe(1);
  });

  it("produces a report for an empty file", async () => {
    const input = await writeInput("");

    const { stdout, code } = await runCli([input]);

    expect(code).toBe(0);
    expect((JSON.parse(stdout) as Report).meta.total_requests).toBe(0);
  });

  it("reports the input path it was given", async () => {
    const input = await writeInput(line() + "\n");

    const { stdout } = await runCli([input]);

    expect((JSON.parse(stdout) as Report).meta.input_file).toBe(input);
  });

  it("fails with a stderr message and non-zero exit when the input file is missing", async () => {
    const { stdout, stderr, code } = await runCli(["./does-not-exist.jsonl"]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/ENOENT/);
  });

  it("fails when no input path is given", async () => {
    const { stderr, code } = await runCli([]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/missing <path-to-file>/);
  });

  it("fails when the rate-limit config is invalid", async () => {
    const input = await writeInput(line() + "\n");
    const badConfig = await writeInput('{"defaults":{"account":{"requests":"lots"}}}');

    const { stdout, stderr, code } = await runCli([input, "--config", badConfig]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/requests must be a non-negative integer/);
  });

  it("accepts --config=<path> as one argument", async () => {
    const input = await writeInput(lines(3).join("\n") + "\n");
    const config = await writeInput('{"defaults":{"account":{"requests":2,"windowSeconds":60}}}');

    const { stdout, code } = await runCli([input, `--config=${config}`]);

    expect(code).toBe(0);
    expect((JSON.parse(stdout) as Report).rate_limit_violations).toMatchObject([{ scope: "account", limit: 2 }]);
  });

  it("rejects an unknown option", async () => {
    const { stderr, code } = await runCli(["--nope"]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown option: --nope/);
  });

  it("rejects a second input path", async () => {
    const { stderr, code } = await runCli(["a.jsonl", "b.jsonl"]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/unexpected argument: b\.jsonl/);
  });

  it("prints usage to stdout for --help and exits zero", async () => {
    const { stdout, stderr, code } = await runCli(["--help"]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toMatch(/Usage: npm run analyze/);
  });
});
