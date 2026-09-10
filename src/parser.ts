import { parseTimestamp } from "./timestamps.js";
import type { ParseResult } from "./types.js";

/** The rejection arm of {@link ParseResult}, returned by each validation step. */
type Failure = Extract<ParseResult, { ok: false }>;

/** Fields that must be present as non-empty strings. */
const STRING_FIELDS = ["request_id", "timestamp", "client_id", "endpoint"] as const;

/**
 * Parses and validates one line of JSONL. Never throws: a bad line is reported
 * as `{ ok: false }` with a human-readable reason so the caller can count it as
 * malformed and move on to the next line.
 */
export const parseLine = (line: string): ParseResult => {
  const parsed = parseObject(line);
  if (!parsed.ok) {
    return parsed;
  }
  const record = parsed.value;

  const badString = validateStringFields(record);
  if (badString !== null) {
    return badString;
  }

  const statusCode = validateStatusCode(record.status_code);
  if (!statusCode.ok) {
    return statusCode;
  }

  const timestamp = record.timestamp as string;
  const timestampMs = parseTimestamp(timestamp);
  if (timestampMs === null) {
    return { ok: false, reason: `invalid timestamp: ${timestamp}` };
  }

  return {
    ok: true,
    request: {
      request_id: record.request_id as string,
      timestamp,
      client_id: record.client_id as string,
      endpoint: record.endpoint as string,
      status_code: statusCode.value,
      timestampMs,
    },
  };
};

/** Parses the line as JSON and requires it to be a plain object. */
const parseObject = (line: string): { ok: true; value: Record<string, unknown> } | Failure => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
};

/** Returns the first string field that is missing or not a non-empty string. */
const validateStringFields = (record: Record<string, unknown>): Failure | null => {
  for (const field of STRING_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null) {
      return { ok: false, reason: `missing field: ${field}` };
    }
    if (typeof value !== "string" || value === "") {
      return { ok: false, reason: `field must be a non-empty string: ${field}` };
    }
  }
  return null;
};

/** Requires an integer HTTP status code in the 100-599 range. */
const validateStatusCode = (value: unknown): { ok: true; value: number } | Failure => {
  if (value === undefined || value === null) {
    return { ok: false, reason: "missing field: status_code" };
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, reason: "field must be an integer: status_code" };
  }
  if (value < 100 || value > 599) {
    return { ok: false, reason: `status_code out of range: ${value}` };
  }
  return { ok: true, value };
};
