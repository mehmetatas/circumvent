import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseLine } from "./parser.js";
import type { RateLimitPolicy } from "./policy.js";
import type { RunContext } from "./report.js";
import { TrafficAggregator } from "./report.js";
import type { Report } from "./types.js";
import { ViolationTracker } from "./violationTracker.js";

/**
 * Reads a file as a stream of lines. The file is never held in memory: readline
 * yields each line as the underlying stream delivers it.
 */
export const readLines = (path: string): AsyncIterable<string> =>
  createInterface({
    input: createReadStream(path, "utf8"),
    crlfDelay: Infinity,
  });

/**
 * Strips a leading UTF-8 byte-order mark. Files exported by some tooling start
 * with one, and it would otherwise make the first record malformed.
 */
const stripBom = (line: string): string => (line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);

/**
 * Consumes a stream of JSONL lines and produces the report.
 *
 * Each line is parsed, validated, aggregated into the traffic statistics and fed
 * to the rate limiters, then discarded. A line that fails validation is counted
 * as malformed and skipped, and processing continues with the next line.
 * Blank lines (such as a trailing newline) are ignored entirely and counted
 * neither as requests nor as malformed input, and a leading byte-order mark is
 * stripped so it cannot spoil the first record.
 */
export const analyzeLines = async (lines: AsyncIterable<string> | Iterable<string>, policy: RateLimitPolicy, context: RunContext): Promise<Report> => {
  const traffic = new TrafficAggregator(context);
  const violations = new ViolationTracker(policy);

  let first = true;
  for await (const raw of lines) {
    const line = first ? stripBom(raw) : raw;
    first = false;

    if (line.trim() === "") {
      continue;
    }

    const result = parseLine(line);
    if (!result.ok) {
      traffic.addMalformed();
      continue;
    }

    traffic.add(result.request);
    violations.record(result.request);
  }

  return traffic.build(violations.finish());
};

/**
 * Analyzes the JSONL file at `path`. `generatedAt` is injectable so a run can be
 * reproduced byte for byte; it defaults to now.
 */
export const analyzeFile = async (path: string, policy: RateLimitPolicy, generatedAt = new Date()): Promise<Report> =>
  analyzeLines(readLines(path), policy, { inputFile: path, generatedAt });
