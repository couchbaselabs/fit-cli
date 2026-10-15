/**
 * Unit tests for comparing the same test across SDKs' reports.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/cross.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestClass } from "../classify.js";
import type { HealthReport, ReportTest } from "../build-report.js";
import { categoriseCross, crossCompare, peerStatus, type CrossPeer } from "../cross.js";

function finding(test: string, cls: TestClass, start = "2026-09-24"): Partial<ReportTest> {
  return { test, cls, since: start, lastFail: "2026-09-30", lastEpisode: { from: start, to: "2026-09-30", nights: 7 } };
}
/** An SDK's report with one active functional series holding `tests`; `seen` is every test it ran. */
function report(sdk: string, tests: Partial<ReportTest>[], seen: string[], complete = true): HealthReport {
  return {
    sdk,
    series: [{ id: "op-onprem-func-lite|functional", kind: "functional", active: true, tests }],
    testsSeen: { functional: { tests: seen, complete }, situational: { tests: [], complete: true } },
  } as unknown as HealthReport;
}

test("a peer that ran the test and never failed it is passing; one that didn't run it is not_run, never passing", () => {
  const go = report("go", [], ["LockTest.x"]);
  assert.equal(peerStatus(go, "LockTest.x", "functional", undefined).status, "passing");
  assert.equal(peerStatus(go, "Other.y", "functional", undefined).status, "not_run");
  // A peer with log-only nights can't vouch that a silent test passed.
  assert.equal(peerStatus(report("node", [], [], false), "Other.y", "functional", undefined).status, "unknown");
  const java = report("java", [finding("LockTest.x", "always", "2026-09-25")], ["LockTest.x"]);
  assert.deepEqual(peerStatus(java, "LockTest.x", "functional", "2026-09-24", "jvm"), {
    sdk: "java", family: "jvm", status: "failing", class: "always", since: "2026-09-25", lastFail: "2026-09-30", sameStart: true,
  });
});

test("the category follows who else runs the test and how they fare", () => {
  const p = (sdk: string, status: CrossPeer["status"], family?: string): CrossPeer => ({ sdk, status, ...(family ? { family } : {}) });
  assert.equal(categoriseCross([p("go", "passing"), p("java", "recovered")], undefined).category, "only-this-sdk");
  assert.equal(categoriseCross([p("go", "failing"), p("java", "intermittent")], undefined).category, "every-sdk");
  assert.match(categoriseCross([p("go", "failing"), p("java", "not_run")], undefined).reason ?? "", /only go also runs it/);
  assert.equal(categoriseCross([p("go", "not_run"), p("java", "unknown")], undefined).category, "not-enough-data");
  // Kotlin failing, its JVM siblings failing, everyone else passing: the shared core.
  const jvm = [p("java", "failing", "jvm"), p("scala", "failing", "jvm"), p("go", "passing"), p("dotnet", "passing")];
  assert.equal(categoriseCross(jvm, "jvm").category, "family");
  assert.equal(categoriseCross(jvm, undefined).category, "mixed", "without a family there's no family pattern");
  assert.equal(categoriseCross([p("java", "passing", "jvm"), p("go", "failing")], "jvm").category, "mixed");
});

test("comparing reports fills every test each report follows up", () => {
  const dotnet = report("dotnet", [finding("LockTest.x", "always"), finding("Only.here", "failing")], ["LockTest.x", "Only.here"]);
  const java = report("java", [finding("LockTest.x", "always")], ["LockTest.x", "Only.here"]);
  const go = report("go", [], ["LockTest.x", "Only.here"]);
  crossCompare([dotnet, java, go], { java: "jvm" });
  const [lock, only] = dotnet.series[0].tests;
  assert.equal(lock.crossSdk?.category, "mixed");
  assert.deepEqual(lock.crossSdk?.peers.map((x) => [x.sdk, x.status]), [["go", "passing"], ["java", "failing"]]);
  assert.equal(only.crossSdk?.category, "only-this-sdk");
  assert.deepEqual(java.series[0].tests[0].crossSdk?.peers.map((x) => [x.sdk, x.status]), [["dotnet", "failing"], ["go", "passing"]]);
});
