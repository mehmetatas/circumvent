/**
 * RFC 3339 date-time: a date, a `T` separator, a time with optional fractional
 * seconds, and a mandatory zone designator (`Z` or `+HH:MM` / `-HH:MM`).
 * `Date.parse` alone is too permissive (it accepts `"2024"`, `"Jan 15 2024"`,
 * and offset-less strings), so the shape is checked first and the calendar
 * validity second.
 */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Parses an ISO-8601 / RFC 3339 timestamp and normalizes it to epoch
 * milliseconds, i.e. to UTC. Returns null if it is not a valid instant.
 */
export const parseTimestamp = (value: string): number | null => {
  if (!TIMESTAMP_PATTERN.test(value)) {
    return null;
  }
  // Date.parse range-checks the calendar (month 13, day 32, hour 25, ... are rejected).
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** Formats epoch milliseconds as a UTC ISO-8601 string, omitting `.000` milliseconds. */
export const formatTimestamp = (ms: number): string => {
  const iso = new Date(ms).toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
};
