import { readFile } from "node:fs/promises";
import type { Limit } from "./types.js";

type LimitSet = {
  account?: Limit;
  endpoints?: Record<string, Limit>;
};

export type RateLimitConfig = {
  defaults: {
    account: Limit;
    endpoints?: Record<string, Limit>;
  };
  accounts?: Record<string, LimitSet>;
};

/** Raised for a malformed configuration file; the CLI turns it into a stderr message. */
export class ConfigError extends Error {}

/**
 * Resolves which limits apply to a (client, endpoint) pair.
 *
 * Account and endpoint limits are independent: a request is measured against
 * both. Account-specific configuration overrides the defaults key by key, so an
 * account may override its account limit, some endpoint limits, or both.
 */
export class RateLimitPolicy {
  constructor(private readonly config: RateLimitConfig) {}

  /** Every client has an account-level limit. */
  accountLimit(clientId: string): Limit {
    return this.config.accounts?.[clientId]?.account ?? this.config.defaults.account;
  }

  /**
   * The endpoint-level limit, or undefined when the endpoint is not configured.
   * Unconfigured (e.g. unknown) endpoints are governed only by the account limit.
   */
  endpointLimit(clientId: string, endpoint: string): Limit | undefined {
    return this.config.accounts?.[clientId]?.endpoints?.[endpoint] ?? this.config.defaults.endpoints?.[endpoint];
  }
}

/** Narrows a config value to a plain object, or reports where the shape is wrong. */
const requireObject = (value: unknown, path: string, expected = "an object"): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be ${expected}`);
  }
  return value as Record<string, unknown>;
};

const parseLimit = (value: unknown, path: string): Limit => {
  const { requests, windowSeconds } = requireObject(value, path, 'an object with "requests" and "windowSeconds"');
  if (typeof requests !== "number" || !Number.isInteger(requests) || requests < 0) {
    throw new ConfigError(`${path}.requests must be a non-negative integer`);
  }
  if (typeof windowSeconds !== "number" || !(windowSeconds > 0)) {
    throw new ConfigError(`${path}.windowSeconds must be a positive number`);
  }
  return { requests, windowSeconds };
};

const parseEndpoints = (value: unknown, path: string): Record<string, Limit> => {
  const endpoints: Record<string, Limit> = {};
  for (const [endpoint, limit] of Object.entries(requireObject(value, path, "an object keyed by endpoint"))) {
    endpoints[endpoint] = parseLimit(limit, `${path}[${JSON.stringify(endpoint)}]`);
  }
  return endpoints;
};

/** Parses one account's overrides; anything it omits falls back to the defaults. */
const parseAccountOverrides = (value: unknown, path: string): LimitSet => {
  const override = requireObject(value, path);
  const limits: LimitSet = {};
  if (override.account !== undefined) {
    limits.account = parseLimit(override.account, `${path}.account`);
  }
  if (override.endpoints !== undefined) {
    limits.endpoints = parseEndpoints(override.endpoints, `${path}.endpoints`);
  }
  return limits;
};

const parseAccounts = (value: unknown): Record<string, LimitSet> => {
  const accounts: Record<string, LimitSet> = {};
  const entries = Object.entries(requireObject(value, "config.accounts", "an object keyed by client_id"));
  for (const [clientId, override] of entries) {
    accounts[clientId] = parseAccountOverrides(override, `config.accounts[${JSON.stringify(clientId)}]`);
  }
  return accounts;
};

/** Validates an already-parsed configuration object and returns a policy. */
export const createPolicy = (raw: unknown): RateLimitPolicy => {
  const root = requireObject(raw, "config", "a JSON object");
  const defaults = requireObject(root.defaults, "config.defaults");

  return new RateLimitPolicy({
    defaults: {
      account: parseLimit(defaults.account, "config.defaults.account"),
      endpoints: defaults.endpoints === undefined ? {} : parseEndpoints(defaults.endpoints, "config.defaults.endpoints"),
    },
    accounts: root.accounts === undefined ? {} : parseAccounts(root.accounts),
  });
};

/** Reads and validates the rate-limit configuration file. */
export const loadPolicy = async (path: string): Promise<RateLimitPolicy> => {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read rate-limit config ${path}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new ConfigError(`invalid JSON in rate-limit config ${path}: ${(error as Error).message}`);
  }
  return createPolicy(raw);
};
