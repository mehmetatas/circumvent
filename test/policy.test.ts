import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";
import { ConfigError, createPolicy, loadPolicy } from "../src/policy.js";
import { TEST_CONFIG, writeInput } from "./helpers.js";

describe("rate-limit policy resolution", () => {
  const policy = createPolicy(TEST_CONFIG);

  it("falls back to the default account limit", () => {
    expect(policy.accountLimit("acct_1")).toStrictEqual({ requests: 5, windowSeconds: 60 });
    expect(policy.accountLimit("acct_never_seen_before")).toStrictEqual({ requests: 5, windowSeconds: 60 });
  });

  it("prefers an account-specific account limit", () => {
    expect(policy.accountLimit("acct_enterprise")).toStrictEqual({ requests: 10, windowSeconds: 60 });
  });

  it("prefers an account-specific endpoint limit", () => {
    expect(policy.endpointLimit("acct_1", "/v1/payments")).toStrictEqual({ requests: 2, windowSeconds: 60 });
    expect(policy.endpointLimit("acct_enterprise", "/v1/payments")).toStrictEqual({ requests: 4, windowSeconds: 60 });
  });

  it.each(["acct_1", "acct_enterprise"])("has no endpoint limit for an unconfigured endpoint (%s)", (clientId) => {
    expect(policy.endpointLimit(clientId, "/v1/unknown")).toBeUndefined();
  });

  it("applies defaults for the parts an account does not override", () => {
    const partial = createPolicy({
      defaults: {
        account: { requests: 5, windowSeconds: 60 },
        endpoints: { "/v1/payments": { requests: 2, windowSeconds: 60 } },
      },
      accounts: {
        acct_partial: { endpoints: { "/v1/reports": { requests: 1, windowSeconds: 30 } } },
      },
    });

    expect(partial.accountLimit("acct_partial")).toStrictEqual({ requests: 5, windowSeconds: 60 });
    expect(partial.endpointLimit("acct_partial", "/v1/payments")).toStrictEqual({ requests: 2, windowSeconds: 60 });
    expect(partial.endpointLimit("acct_partial", "/v1/reports")).toStrictEqual({ requests: 1, windowSeconds: 30 });
  });

  it("applies an account override that sets only an account limit", () => {
    const accountOnly = createPolicy({
      defaults: {
        account: { requests: 5, windowSeconds: 60 },
        endpoints: { "/v1/payments": { requests: 2, windowSeconds: 60 } },
      },
      accounts: { acct_big: { account: { requests: 500, windowSeconds: 60 } } },
    });

    expect(accountOnly.accountLimit("acct_big")).toStrictEqual({ requests: 500, windowSeconds: 60 });
    // Its endpoint limits still come from the defaults.
    expect(accountOnly.endpointLimit("acct_big", "/v1/payments")).toStrictEqual({ requests: 2, windowSeconds: 60 });
  });

  it("works without any optional sections", () => {
    const minimal = createPolicy({ defaults: { account: { requests: 1, windowSeconds: 1 } } });

    expect(minimal.accountLimit("acct_1")).toStrictEqual({ requests: 1, windowSeconds: 1 });
    expect(minimal.endpointLimit("acct_1", "/v1/widgets")).toBeUndefined();
  });
});

describe("rate-limit config validation", () => {
  it.each([
    ["not an object", []],
    ["missing defaults", {}],
    ["missing default account limit", { defaults: {} }],
    ["non-integer requests", { defaults: { account: { requests: 1.5, windowSeconds: 60 } } }],
    ["zero window", { defaults: { account: { requests: 5, windowSeconds: 0 } } }],
    ["malformed endpoint limit", { defaults: { account: { requests: 5, windowSeconds: 60 }, endpoints: { "/a": 5 } } }],
    ["malformed account override", { defaults: { account: { requests: 5, windowSeconds: 60 } }, accounts: { acct_1: "nope" } }],
  ])("rejects config: %s", (_name, config) => {
    expect(() => createPolicy(config)).toThrow(ConfigError);
  });

  it("names the offending path in the error", () => {
    expect(() => createPolicy({ defaults: { account: { requests: "lots" } } })).toThrow(/config\.defaults\.account\.requests must be a non-negative integer/);
  });
});

describe("loadPolicy", () => {
  it("reports a config file that cannot be read", async () => {
    await expect(loadPolicy("./no-such-config.json")).rejects.toThrow(ConfigError);
    await expect(loadPolicy("./no-such-config.json")).rejects.toThrow(/cannot read rate-limit config/);
  });

  it("reports a config file that is not valid JSON", async () => {
    const path = await writeInput("{ not json");

    await expect(loadPolicy(path)).rejects.toThrow(/invalid JSON in rate-limit config/);
  });

  it("loads the shipped policy from disk", async () => {
    const policy = await loadPolicy(fileURLToPath(new URL("../config/rate-limits.json", import.meta.url)));

    expect(policy.accountLimit("acct_1")).toStrictEqual({ requests: 1000, windowSeconds: 60 });
  });
});

describe("shipped config", () => {
  it("config/rate-limits.json is valid and matches the documented example values", async () => {
    const path = fileURLToPath(new URL("../config/rate-limits.json", import.meta.url));
    const policy = createPolicy(JSON.parse(await readFile(path, "utf8")));

    expect(policy.accountLimit("acct_1")).toStrictEqual({ requests: 1000, windowSeconds: 60 });
    expect(policy.accountLimit("acct_enterprise")).toStrictEqual({ requests: 10000, windowSeconds: 60 });
    expect(policy.endpointLimit("acct_1", "/v1/payments")).toStrictEqual({ requests: 20, windowSeconds: 60 });
    expect(policy.endpointLimit("acct_enterprise", "/v1/payments")).toStrictEqual({ requests: 100, windowSeconds: 60 });
  });
});
