import { describe, expect, it } from "@jest/globals";
import { DEFAULT_CONFIG_PATH, errorMessage, parseArgs, run, USAGE, UsageError } from "../src/cli.js";
import type { Report } from "../src/types.js";
import { line, lines, writeInput } from "./helpers.js";

/** Collects what the CLI writes, so `run` can be exercised in-process. */
const captureIo = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
};

describe("errorMessage", () => {
  it.each([
    [new Error("boom"), "boom"],
    // An error from another realm is not an instance of this realm's Error.
    [{ message: "cross-realm failure" }, "cross-realm failure"],
    ["a thrown string", "a thrown string"],
    [{ message: 42 }, "[object Object]"],
    [null, "null"],
  ] as [unknown, string][])("describes %p as %p", (thrown, expected) => {
    expect(errorMessage(thrown)).toBe(expected);
  });
});

describe("parseArgs", () => {
  it("takes the input path and defaults the config to the shipped policy", () => {
    expect(parseArgs(["./input.jsonl"])).toStrictEqual({
      inputPath: "./input.jsonl",
      configPath: DEFAULT_CONFIG_PATH,
      help: false,
    });
  });

  it.each(["--config", "-c"])("reads %s <path> as two arguments", (flag) => {
    expect(parseArgs(["./input.jsonl", flag, "./limits.json"])).toMatchObject({
      inputPath: "./input.jsonl",
      configPath: "./limits.json",
    });
  });

  it("reads --config=<path> as one argument", () => {
    expect(parseArgs(["--config=./limits.json", "./input.jsonl"])).toMatchObject({
      inputPath: "./input.jsonl",
      configPath: "./limits.json",
    });
  });

  it("does not mistake the config value for the input path", () => {
    expect(parseArgs(["-c", "./limits.json", "./input.jsonl"]).inputPath).toBe("./input.jsonl");
  });

  it.each(["--help", "-h"])("reports %s without needing an input path", (flag) => {
    expect(parseArgs([flag])).toMatchObject({ help: true });
  });

  it.each([
    [[], /missing <path-to-file>/],
    [["a.jsonl", "b.jsonl"], /unexpected argument: b\.jsonl/],
    [["--nope"], /unknown option: --nope/],
    [["./input.jsonl", "--config"], /--config requires a path/],
    [["./input.jsonl", "-c"], /-c requires a path/],
  ] as [string[], RegExp][])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe("run", () => {
  it("writes the report to stdout, nothing to stderr, and returns 0", async () => {
    const path = await writeInput(lines(3).join("\n") + "\n");
    const { io, stdout, stderr } = captureIo();

    await expect(run([path], io)).resolves.toBe(0);

    expect(stderr()).toBe("");
    expect((JSON.parse(stdout()) as Report).meta.valid_requests).toBe(3);
  });

  it("uses the config file it is pointed at", async () => {
    const path = await writeInput(lines(3).join("\n") + "\n");
    const config = await writeInput('{"defaults":{"account":{"requests":2,"windowSeconds":60}}}');
    const { io, stdout } = captureIo();

    await expect(run([path, "--config", config], io)).resolves.toBe(0);

    expect((JSON.parse(stdout()) as Report).rate_limit_violations).toMatchObject([{ scope: "account", limit: 2 }]);
  });

  it("prints usage to stdout for --help and returns 0", async () => {
    const { io, stdout, stderr } = captureIo();

    await expect(run(["--help"], io)).resolves.toBe(0);

    expect(stdout()).toBe(`${USAGE}\n`);
    expect(stderr()).toBe("");
  });

  it("prints the error and usage to stderr for a bad command line, and returns 1", async () => {
    const { io, stdout, stderr } = captureIo();

    await expect(run([], io)).resolves.toBe(1);

    expect(stdout()).toBe("");
    expect(stderr()).toMatch(/error: missing <path-to-file>/);
    expect(stderr()).toContain(USAGE);
  });

  it("reports a missing input file on stderr without usage, and returns 1", async () => {
    const { io, stdout, stderr } = captureIo();

    await expect(run(["./no-such-file.jsonl"], io)).resolves.toBe(1);

    expect(stdout()).toBe("");
    expect(stderr()).toMatch(/error: ENOENT/);
    expect(stderr()).not.toContain(USAGE);
  });

  it("reports an invalid config on stderr and returns 1", async () => {
    const path = await writeInput(line() + "\n");
    const badConfig = await writeInput('{"defaults":{"account":{"requests":"lots"}}}');
    const { io, stdout, stderr } = captureIo();

    await expect(run([path, "--config", badConfig], io)).resolves.toBe(1);

    expect(stdout()).toBe("");
    expect(stderr()).toMatch(/requests must be a non-negative integer/);
  });
});
