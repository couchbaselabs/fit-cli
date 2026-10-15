/**
 * Unit tests for the fit health commands' argument parsing.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/tests/cli-args.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { STORE_OPTION, parseHealthArgs, parseSdkCommandArgs } from "../cli-args.js";

const OPTIONS = { ...STORE_OPTION, days: { type: "string" }, "no-slack": { type: "boolean" } } as const;

test("the SDK is found wherever it is, even right after a boolean flag", () => {
  for (const argv of [["--no-slack", "dotnet"], ["dotnet", "--no-slack"], ["--days", "5", "dotnet", "--no-slack"], ["--store", "s3://b/p/", "--no-slack", "dotnet"]]) {
    const a = parseHealthArgs(argv, OPTIONS, "usage");
    assert.equal(a.sdk, "dotnet", argv.join(" "));
    assert.equal(a.values["no-slack"], true, argv.join(" "));
  }
  const a = parseHealthArgs(["--days", "5", "--store", "s3://b/p/", "go"], OPTIONS, "usage");
  assert.deepEqual([a.sdk, a.values.days, a.values.store], ["go", "5", "s3://b/p/"]);
});

test("--help and -h are understood by every command", () => {
  assert.equal(parseHealthArgs(["--help"], OPTIONS, "usage").help, true);
  assert.equal(parseHealthArgs(["dotnet", "-h"], OPTIONS, "usage").help, true);
  assert.equal(parseHealthArgs(["dotnet"], OPTIONS, "usage").help, false);
});

test("an unknown flag, a missing value or a second SDK is an error that shows the usage", () => {
  assert.throws(() => parseHealthArgs(["dotnet", "--nope"], OPTIONS, "the usage"), /--nope[\s\S]*the usage/);
  assert.throws(() => parseHealthArgs(["dotnet", "--days"], OPTIONS, "the usage"), /--days[\s\S]*the usage/);
  assert.throws(() => parseHealthArgs(["dotnet", "java"], OPTIONS, "the usage"), /Unexpected argument: java[\s\S]*the usage/);
  assert.equal(parseHealthArgs([], OPTIONS, "usage").sdk, undefined);
});

test("a command on one SDK prints its usage for --help or no arguments, and refuses a missing SDK", () => {
  const log = console.log;
  const printed: unknown[] = [];
  console.log = (m: unknown) => printed.push(m);
  try {
    assert.equal(parseSdkCommandArgs([], OPTIONS, "the usage"), undefined);
    assert.equal(parseSdkCommandArgs(["dotnet", "--help"], OPTIONS, "the usage"), undefined);
  } finally {
    console.log = log;
  }
  assert.deepEqual(printed, ["the usage", "the usage"]);
  assert.throws(() => parseSdkCommandArgs(["--no-slack"], OPTIONS, "the usage"), /Name an SDK\.[\s\S]*the usage/);
  const a = parseSdkCommandArgs(["--days", "5", "go"], OPTIONS, "the usage");
  assert.deepEqual([a?.sdk, a?.values.days], ["go", "5"]);
});
