import { fileURLToPath } from "node:url";
import { analyzeFile } from "./analyze.js";
import { loadPolicy } from "./policy.js";

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../config/rate-limits.json", import.meta.url));

export const USAGE = `Usage: npm run analyze <path-to-file> [--config <path>]

Reads a JSONL HTTP request log and writes a single JSON traffic report to stdout.
The rate-limit policy defaults to config/rate-limits.json.`;

/** An invalid command line, as opposed to a runtime failure. */
export class UsageError extends Error {}

export type Args = {
  inputPath: string;
  configPath: string;
  help: boolean;
};

/** Where the CLI writes; injected so it can be exercised without a child process. */
export type Streams = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

/**
 * Reads `--config <path>` or `--config=<path>` at `index`, returning the value and
 * the index it consumed up to, or null when the argument is not that option.
 */
const readConfigOption = (argv: string[], index: number): { value: string; lastIndex: number } | null => {
  const arg = argv[index]!;
  if (arg === "--config" || arg === "-c") {
    const value = argv[index + 1];
    if (value === undefined) {
      throw new UsageError(`${arg} requires a path`);
    }
    return { value, lastIndex: index + 1 };
  }
  if (arg.startsWith("--config=")) {
    return { value: arg.slice("--config=".length), lastIndex: index };
  }
  return null;
};

/** Parses the argument list, throwing {@link UsageError} for anything unusable. */
export const parseArgs = (argv: string[]): Args => {
  const positional: string[] = [];
  let configPath = DEFAULT_CONFIG_PATH;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const config = readConfigOption(argv, i);
    if (config !== null) {
      configPath = config.value;
      i = config.lastIndex;
    } else if (arg === "--help" || arg === "-h") {
      return { inputPath: "", configPath, help: true };
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new UsageError("missing <path-to-file>");
  }
  if (positional.length > 1) {
    throw new UsageError(`unexpected argument: ${positional[1]}`);
  }
  return { inputPath: positional[0]!, configPath, help: false };
};

/**
 * Extracts a message from a thrown value. `instanceof Error` is not enough: an
 * error raised in another realm (a worker, a vm context, some test runners) is
 * not an instance of this realm's Error, and `String(error)` would then print a
 * redundant "Error: " prefix.
 */
export const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error as { message: unknown };
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
};

/**
 * Runs the analyzer and returns the process exit code. The report is the only
 * thing ever written to stdout; failures go to stderr and return 1.
 */
export const run = async (argv: string[], io: Streams): Promise<number> => {
  try {
    const { inputPath, configPath, help } = parseArgs(argv);
    if (help) {
      io.stdout(`${USAGE}\n`);
      return 0;
    }
    const policy = await loadPolicy(configPath);
    const report = await analyzeFile(inputPath, policy);
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`error: ${errorMessage(error)}\n`);
    if (error instanceof UsageError) {
      io.stderr(`${USAGE}\n`);
    }
    return 1;
  }
};
