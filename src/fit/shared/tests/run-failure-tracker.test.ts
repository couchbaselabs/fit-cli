import assert from "node:assert/strict";
import { test } from "node:test";
import { formatFailureSummaryLine, shouldHoistFailureSnippet, worstFailureShouldExitNonZero } from "../../../util/non-fit/artifacts.js";
import { RunFailureTracker } from "../run-failure-tracker.js";

const ctx = { instanceIndex: 0, clusterIndex: 1, sessionIndex: 2 };

test("RunFailureTracker: worst-wins ordering — lower severity does not displace higher", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToCluster", "cluster failed", { instanceIndex: 0, clusterIndex: 1 });
  tracker.record("NonFatal", "minor", { instanceIndex: 0, clusterIndex: 1 });
  tracker.record("FatalToSession", "session failed", { instanceIndex: 0, clusterIndex: 1 });

  assert.equal(tracker.worst?.classification, "FatalToCluster");
  assert.equal(tracker.worst?.message, "cluster failed");
});

test("RunFailureTracker: FatalToAll displaces FatalToCluster", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToCluster", "cluster failed", { instanceIndex: 0, clusterIndex: 0 });
  tracker.record("FatalToAll", "everything failed", { instanceIndex: 0, clusterIndex: 1 });

  assert.equal(tracker.worst?.classification, "FatalToAll");
  assert.equal(tracker.worst?.message, "everything failed");
});

test("RunFailureTracker: FatalToInstance sits between FatalToCluster and FatalToAll", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToCluster", "cluster failed", { instanceIndex: 0, clusterIndex: 0 });
  tracker.record("FatalToInstance", "instance failed", { instanceIndex: 0 });
  assert.equal(tracker.worst?.classification, "FatalToInstance");

  tracker.record("FatalToAll", "everything failed", { instanceIndex: 0 });
  assert.equal(tracker.worst?.classification, "FatalToAll");
});

test("RunFailureTracker: count increments for every record call", () => {
  const tracker = new RunFailureTracker();
  tracker.record("NonFatal", "a", ctx);
  tracker.record("FatalToSession", "b", ctx);
  tracker.record("FatalToCluster", "c", ctx);

  assert.equal(tracker.failureCount, 3);
});

test("RunFailureTracker: shouldExitNonZero is false for no failures", () => {
  const tracker = new RunFailureTracker();
  assert.equal(tracker.shouldExitNonZero(), false);
});

test("RunFailureTracker: shouldExitNonZero is false for NonFatal only", () => {
  const tracker = new RunFailureTracker();
  tracker.record("NonFatal", "minor", ctx);
  assert.equal(tracker.shouldExitNonZero(), false);
});

test("RunFailureTracker: shouldExitNonZero is true for FatalToSession", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToSession", "session failed", ctx);
  assert.equal(tracker.shouldExitNonZero(), true);
});

test("RunFailureTracker: shouldExitNonZero is true for FatalToCluster", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToCluster", "cluster failed", ctx);
  assert.equal(tracker.shouldExitNonZero(), true);
});

test("RunFailureTracker: shouldExitNonZero is true for FatalToAll", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToAll", "all failed", ctx);
  assert.equal(tracker.shouldExitNonZero(), true);
});

test("worstFailureShouldExitNonZero: false for NonFatal", () => {
  assert.equal(worstFailureShouldExitNonZero({ classification: "NonFatal", message: "x", context: { instanceIndex: 0 } }), false);
});

test("worstFailureShouldExitNonZero: true for FatalToSession boundary", () => {
  assert.equal(worstFailureShouldExitNonZero({ classification: "FatalToSession", message: "x", context: { instanceIndex: 0 } }), true);
});

test("formatFailureSummaryLine: 1-based instance/cluster", () => {
  const line = formatFailureSummaryLine(
    { classification: "FatalToCluster", message: "cluster failed", context: { instanceIndex: 0, clusterIndex: 1 } },
    1,
  );
  assert.equal(line, "Returning non-zero due to FatalToCluster error 'cluster failed' on instance 1, cluster 2");
});

test("formatFailureSummaryLine: includes cluster and session when present", () => {
  const line = formatFailureSummaryLine(
    { classification: "FatalToSession", message: "tests failed", context: { instanceIndex: 1, clusterIndex: 0, sessionIndex: 2 } },
    1,
  );
  assert.equal(line, "Returning non-zero due to FatalToSession error 'tests failed' on instance 2, cluster 1, session 3");
});

test("formatFailureSummaryLine: clusterless session omits cluster", () => {
  const line = formatFailureSummaryLine(
    { classification: "FatalToSession", message: "tests failed", context: { instanceIndex: 0, sessionIndex: 1, clusterless: true } },
    1,
  );
  assert.equal(line, "Returning non-zero due to FatalToSession error 'tests failed' on instance 1, session 2");
});

test("formatFailureSummaryLine: prefers the standardised label over raw indexes", () => {
  const line = formatFailureSummaryLine(
    {
      classification: "FatalToSession",
      message: "FIT tests failed — check the test-driver log for details.",
      context: { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0, label: "aws1 / 7.6-stable / java:main / func" },
    },
    1,
  );
  assert.equal(
    line,
    "Returning non-zero due to FatalToSession error 'FIT tests failed — check the test-driver log for details.' on aws1 / 7.6-stable / java:main / func",
  );
});

test("formatFailureSummaryLine: label still gets the +N more suffix", () => {
  const line = formatFailureSummaryLine(
    { classification: "FatalToSession", message: "tests failed", context: { instanceIndex: 0, label: "aws1 / 7.6-stable / java:main / func" } },
    2,
  );
  assert.equal(line, "Returning non-zero due to FatalToSession error 'tests failed' on aws1 / 7.6-stable / java:main / func (+1 more failure)");
});

test("formatFailureSummaryLine: shows +N more for multiple failures", () => {
  const line = formatFailureSummaryLine(
    { classification: "FatalToCluster", message: "cluster failed", context: { instanceIndex: 0, clusterIndex: 0 } },
    3,
  );
  assert.match(line, /\(\+2 more failures\)/);
});

test("formatFailureSummaryLine: shows +1 more singular for two failures", () => {
  const line = formatFailureSummaryLine(
    { classification: "FatalToCluster", message: "cluster failed", context: { instanceIndex: 0, clusterIndex: 0 } },
    2,
  );
  assert.match(line, /\(\+1 more failure\)/);
});

test("RunFailureTracker: a test-results failure carries the flag through to the worst failure", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToSession", "FIT tests failed", ctx, { explainedByTestResults: true });

  assert.equal(tracker.worst?.explainedByTestResults, true);
  assert.equal(shouldHoistFailureSnippet(tracker.worst), false);
});

test("RunFailureTracker: at equal severity, an unexplained failure displaces a test-results one", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToSession", "FIT tests failed", ctx, { explainedByTestResults: true });
  tracker.record("FatalToSession", "performer sanity check failed", ctx);

  assert.equal(tracker.worst?.message, "performer sanity check failed");
  assert.equal(shouldHoistFailureSnippet(tracker.worst), true);
});

test("RunFailureTracker: a test-results failure does not displace an equal-severity unexplained one", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToSession", "performer sanity check failed", ctx);
  tracker.record("FatalToSession", "FIT tests failed", ctx, { explainedByTestResults: true });

  assert.equal(tracker.worst?.message, "performer sanity check failed");
});

test("RunFailureTracker: severity still outranks the explained-by-test-results tie-break", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToRun", "no JUnit reports", ctx);
  tracker.record("FatalToCluster", "FIT tests failed", ctx, { explainedByTestResults: true });

  assert.equal(tracker.worst?.message, "FIT tests failed");
  assert.equal(shouldHoistFailureSnippet(tracker.worst), false);
});

test("RunFailureTracker: a failing test run still exits non-zero when its snippet is suppressed", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToSession", "FIT tests failed", ctx, { explainedByTestResults: true });

  assert.equal(tracker.shouldExitNonZero(), true);
  assert.equal(worstFailureShouldExitNonZero(tracker.worst!), true);
});

test("shouldHoistFailureSnippet: a failure with no test-results explanation is hoisted", () => {
  assert.equal(
    shouldHoistFailureSnippet({ classification: "FatalToCluster", message: "cbdino allocate failed", context: { instanceIndex: 0 } }),
    true,
  );
});
