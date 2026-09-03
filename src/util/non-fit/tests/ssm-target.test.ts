/**
 * Unit tests for splitting SSM's CloudWatch output back into stdout and stderr.
 *
 * Run on their own:
 *   node --import tsx --test src/util/non-fit/tests/ssm-target.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { inlineOutputIsComplete, partitionLogEvents } from "../ssm-target.js";

const stdoutStream = "cmd-1/i-abc/aws-runShellScript/stdout";
const stderrStream = "cmd-1/i-abc/aws-runShellScript/stderr";

test("partitionLogEvents keeps stdout free of stderr", () => {
  const out = partitionLogEvents([
    { message: "couchbase2://cng-host:443\n", logStreamName: stdoutStream },
    { message: "INFO logger initialized\n", logStreamName: stderrStream },
  ]);
  assert.equal(out.stdout, "couchbase2://cng-host:443\n");
  assert.equal(out.stderr, "INFO logger initialized\n");
});

// The regression this guards: a connection string on stdout with cbdinocluster's
// diagnostics folded in after it parses as a malformed multi-line connection string.
test("partitionLogEvents does not fold interleaved stderr into the captured value", () => {
  const out = partitionLogEvents([
    { message: "INFO attempting to identify cluster\n", logStreamName: stderrStream },
    { message: "couchbase2://cng-host:443", logStreamName: stdoutStream },
    { message: "\n2026/08/12 cngHost: cng-host <nil>\n", logStreamName: stderrStream },
  ]);
  assert.equal(out.stdout, "couchbase2://cng-host:443");
  assert.ok(!out.stdout.includes("cngHost"));
});

test("partitionLogEvents preserves both streams, in event order, in combined", () => {
  const out = partitionLogEvents([
    { message: "one\n", logStreamName: stdoutStream },
    { message: "two\n", logStreamName: stderrStream },
    { message: "three\n", logStreamName: stdoutStream },
  ]);
  assert.equal(out.combined, "one\ntwo\nthree\n");
});

test("partitionLogEvents keeps unclassified events with the data rather than dropping them", () => {
  const out = partitionLogEvents([
    { message: "value\n" },
    { message: "other\n", logStreamName: "cmd-1/i-abc/aws-runShellScript/somethingelse" },
  ]);
  assert.equal(out.stdout, "value\nother\n");
  assert.equal(out.stderr, "");
});

test("partitionLogEvents skips events with no message", () => {
  const out = partitionLogEvents([
    { logStreamName: stdoutStream },
    { message: "kept\n", logStreamName: stdoutStream },
  ]);
  assert.equal(out.stdout, "kept\n");
  assert.equal(out.combined, "kept\n");
});

test("partitionLogEvents handles an empty read", () => {
  const out = partitionLogEvents([]);
  assert.deepEqual(out, { stdout: "", stderr: "", combined: "" });
});

const inline = (stdout: string, stderr = "") => ({ stdout, stderr, combined: stdout + stderr });

test("inlineOutputIsComplete accepts ordinary short output", () => {
  assert.equal(inlineOutputIsComplete(inline("true\n")), true);
  assert.equal(inlineOutputIsComplete(inline("")), true);
});

test("inlineOutputIsComplete rejects output SSM marked as truncated", () => {
  assert.equal(inlineOutputIsComplete(inline("lots of stuff\n---output truncated---\n")), false);
  // The marker can land on either stream, and `combined` is what we scan.
  assert.equal(inlineOutputIsComplete(inline("fine\n", "Output truncated")), false);
});

test("inlineOutputIsComplete rejects a stream sitting at its cap even with no marker", () => {
  // Belt-and-braces: output landing exactly on the boundary without a marker must not be
  // mistaken for whole, since capture()'s callers parse it as data.
  assert.equal(inlineOutputIsComplete(inline("x".repeat(24_000))), false);
  assert.equal(inlineOutputIsComplete(inline("ok", "e".repeat(8_000))), false);
  assert.equal(inlineOutputIsComplete(inline("x".repeat(23_999))), true);
});
