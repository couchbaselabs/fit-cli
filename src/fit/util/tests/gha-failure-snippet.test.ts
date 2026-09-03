import test from "node:test";
import assert from "node:assert/strict";
import {
  extractFailureTail,
  FAILURE_SNIPPET_RESERVE_BYTES,
  likelyCauseLine,
  renderFailureSnippetBlock,
  STEP_SUMMARY_BUDGET_BYTES,
  STEP_SUMMARY_HARD_LIMIT_BYTES,
} from "../gha.js";

// Both fixtures are real terminal output, trimmed, from run 33718695889 — the run that
// prompted the failure snippet. They are the two shapes that matter: a tool rejecting a
// flag, where the message is buried under the tool's own --help dump, and a tool timing
// out, where the message is one enormous line.
const CBDINO_BAD_FLAG_LOG = [
  "[05:30:15·aws1] Flags:",
  "[05:30:15·aws1]       --auto                    Automatically setup without any interactivity",
  "[05:30:15·aws1]       --noci                    Disable CI mode when using --auto",
  "[05:30:15·aws1] ",
  "[05:30:15·aws1] 2026/09/03 05:29:54 failed to initialize command line parser: unknown flag: --capella-create-pool",
  "[05:30:15·aws1] failed to run commands: exit status 1",
  "",
  "[05:30:15·aws1] ── Run finished — no more iterations, clusters or instances to run. ──",
  "[05:30:15·aws1] Terminating instance i-07e4a34a082ee72f7...",
  "[05:30:16] Artifact filename                    | Size     | Purpose",
  "[05:30:16] ✓ Uploaded run artifacts to s3://fit-cli/runs/20260903-052435-ef2a.zip",
].join("\n");

const CAO_TIMEOUT_LOG = [
  '[05:55:29·aws1] 2026-09-03T05:35:05.914Z\tINFO\tcaocontrol/controller.go:916\twaiting for couchbase cluster to be available\t{"expectedSize": 3}',
  `[05:55:29·aws1] 2026-09-03T05:55:06.321Z\tFATAL\tcmd/allocate.go:92\tcluster deployment failed\t{"error": "failed to create cluster resource: failed to wait for cluster: failed to wait for couchbase cluster: timed out waiting for condition", "errorVerbose": "${"x".repeat(4000)}"}`,
  "[05:55:29·aws1] failed to run commands: exit status 1",
  "[05:55:54·aws1] FitCliError: setup-cluster: cbdinocluster failed to allocate the cluster: command on i-0f550ff7708102ee3 exited with status Failed (code 1)",
  "[05:55:54·aws1] FitCliError/FatalToCluster: setup-cluster didn't produce a cluster, so this execution group can't continue.",
  "[05:55:54·aws1] ── Run finished — no more iterations, clusters or instances to run. ──",
].join("\n");

test("extractFailureTail: cuts at the run-finished marker, dropping teardown and upload noise", () => {
  const tail = extractFailureTail(CBDINO_BAD_FLAG_LOG);
  assert.ok(tail.some((line) => line.includes("unknown flag: --capella-create-pool")));
  assert.ok(!tail.some((line) => line.includes("Terminating instance")), "teardown should be cut");
  assert.ok(!tail.some((line) => line.includes("Artifact filename")), "artifact table should be cut");
  assert.ok(!tail.some((line) => line.includes("Uploaded run artifacts")), "upload chatter should be cut");
});

test("extractFailureTail: strips the [HH:MM:SS·ctx] line prefix", () => {
  const tail = extractFailureTail(CBDINO_BAD_FLAG_LOG);
  assert.ok(tail.every((line) => !/^\[\d{2}:\d{2}:\d{2}/.test(line)), `unexpected prefix in ${JSON.stringify(tail)}`);
});

test("extractFailureTail: no marker means take the end of the log", () => {
  assert.deepEqual(extractFailureTail("[05:30:15] first\n[05:30:15] second"), ["first", "second"]);
});

test("extractFailureTail: honours the line limit, keeping the newest", () => {
  const log = Array.from({ length: 50 }, (_, i) => `[05:30:15] line ${i}`).join("\n");
  assert.deepEqual(extractFailureTail(log, 3), ["line 47", "line 48", "line 49"]);
});

test("extractFailureTail: truncates a single huge line so it cannot swallow the snippet", () => {
  const tail = extractFailureTail(CAO_TIMEOUT_LOG);
  assert.ok(tail.every((line) => line.length <= 241), "every line should be truncated to the cap");
  assert.ok(tail.some((line) => line.includes("cluster deployment failed")));
});

test("extractFailureTail: drops trailing blank lines rather than spending the budget on them", () => {
  assert.deepEqual(extractFailureTail("[05:30:15] real line\n\n\n\n"), ["real line"]);
});

test("likelyCauseLine: finds the buried message under a tool's own --help output", () => {
  const cause = likelyCauseLine(extractFailureTail(CBDINO_BAD_FLAG_LOG));
  assert.ok(cause?.includes("unknown flag: --capella-create-pool"), `got ${cause}`);
});

test("likelyCauseLine: skips the generic exit-status line every failure ends with", () => {
  const cause = likelyCauseLine(extractFailureTail(CBDINO_BAD_FLAG_LOG));
  assert.ok(!cause?.startsWith("failed to run commands"), `got ${cause}`);
});

test("likelyCauseLine: skips FitCliError lines, which are already the heading", () => {
  const cause = likelyCauseLine(extractFailureTail(CAO_TIMEOUT_LOG));
  assert.ok(cause?.includes("cluster deployment failed"), `got ${cause}`);
  assert.ok(!cause?.includes("FitCliError"), `got ${cause}`);
});

test("likelyCauseLine: undefined when nothing in the tail looks like an error", () => {
  assert.equal(likelyCauseLine(["all fine", "still fine"]), undefined);
});

test("renderFailureSnippetBlock: not collapsed — the reason CI is red needs no click", () => {
  const block = renderFailureSnippetBlock({ classification: "FatalToCluster", message: "no cluster" }, ["boom"]);
  assert.ok(!block.includes("<details>"), "failure block must not be collapsed");
  assert.ok(block.startsWith("### ❌ FatalToCluster"));
});

test("renderFailureSnippetBlock: heading carries the classification and the position label", () => {
  const block = renderFailureSnippetBlock(
    { classification: "FatalToCluster", message: "no cluster", label: "aws1 / 8.0.2-5503" },
    [],
  );
  assert.ok(block.includes("### ❌ FatalToCluster — aws1 / 8.0.2-5503"));
});

test("renderFailureSnippetBlock: hoists the likely cause above the code block", () => {
  const block = renderFailureSnippetBlock(
    { message: "sh on i-07e4a exited with status Failed (code 1)" },
    extractFailureTail(CBDINO_BAD_FLAG_LOG),
  );
  const causeAt = block.indexOf("**Likely cause:**");
  assert.ok(causeAt >= 0, "should render a likely cause");
  assert.ok(causeAt < block.indexOf("```text"), "likely cause should come before the code block");
  assert.ok(block.includes("unknown flag: --capella-create-pool"));
});

test("renderFailureSnippetBlock: does not repeat the message when it is itself the likely cause", () => {
  const block = renderFailureSnippetBlock({ message: "unknown flag: --nope" }, ["unknown flag: --nope"]);
  assert.equal(block.split("unknown flag: --nope").length - 1, 2, "once as the cause, once in the code block");
});

test("renderFailureSnippetBlock: backticks in the cause cannot break out of the inline code span", () => {
  const block = renderFailureSnippetBlock({ message: "x" }, ["Error: bad `quoted` thing"]);
  assert.ok(block.includes("**Likely cause:** `Error: bad 'quoted' thing`"));
});

test("the snippet's degradation ladder is ordered richest first, as chooseBlockWithinBudget requires", () => {
  const heading = { classification: "FatalToCluster", message: "no cluster", label: "aws1" };
  const tail = extractFailureTail(Array.from({ length: 40 }, (_, i) => `[05:30:15] Error: line ${i}`).join("\n"));
  const ladder = [
    renderFailureSnippetBlock(heading, tail),
    renderFailureSnippetBlock(heading, tail.slice(-5)),
    renderFailureSnippetBlock(heading, []),
  ].map((block) => Buffer.byteLength(block, "utf8"));
  assert.ok(ladder[0] > ladder[1], "full tail should be bigger than the 5-line form");
  assert.ok(ladder[1] > ladder[2], "the 5-line form should be bigger than the heading alone");
});

test("even the leanest rung keeps the likely cause out of the heading-only form's way", () => {
  const block = renderFailureSnippetBlock({ classification: "FatalToAll", message: "it broke", label: "aws1" }, []);
  assert.ok(block.includes("### ❌ FatalToAll — aws1"));
  assert.ok(block.includes("it broke"));
  assert.ok(!block.includes("```text"), "no code block when there is no tail left");
});

test("the failure-snippet reserve fits in the headroom below GitHub's hard limit", () => {
  assert.ok(FAILURE_SNIPPET_RESERVE_BYTES > 0);
  assert.ok(FAILURE_SNIPPET_RESERVE_BYTES < STEP_SUMMARY_HARD_LIMIT_BYTES - STEP_SUMMARY_BUDGET_BYTES);
});
