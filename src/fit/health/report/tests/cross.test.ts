/**
 * Unit tests for comparing the same test across SDKs' reports.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/cross.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestClass } from "../classify.js";
import { categoriseCross, crossCompare, peerStatus, summariseCross, type CrossPeer } from "../cross.js";
import type { TriageFinding, TriageReport } from "../triage.js";

const SERIES = "op-onprem-func-lite|functional";
function finding(test: string, cls: TestClass, start = "2026-09-24"): TriageFinding {
  const dot = test.indexOf(".");
  return {
    test,
    class: test.slice(0, dot),
    method: test.slice(dot + 1),
    series: SERIES,
    classification: { class: cls, label: cls, streak: 1, episodes: 1, windowFails: 1, windowRuns: 30, since: start, lastFail: "2026-09-30" },
    history: [],
    evidence: { firstFailing: { date: start, outcome: "failed", run: { url: "", repo: "r", runId: 1, attempt: 1 }, source: "run-archive-junit" } },
    driverChanges: null,
    crossSdk: null,
  };
}
function report(sdk: string, findings: TriageFinding[], seen: string[], complete = true): TriageReport {
  return {
    schema: "fit-health-triage/1",
    sdk,
    generatedAt: "",
    window: { start: "2026-07-03", end: "2026-09-30", nights: 90, classificationDays: 30, recentDays: 14 },
    coverage: { records: 0, fromJunit: 0, fromLog: 0 },
    blackout: [],
    unreadableRuns: [],
    series: [{ id: SERIES, preset: "op-onprem-func-lite", kind: "functional", where: "on-prem", label: "", params: {}, clusters: [], nights: 90, degraded: [], aborted: [], active: true }],
    findings,
    testsSeen: { functional: { tests: seen, complete }, situational: { tests: [], complete: true } },
  };
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

test("comparing reports fills every finding, and the page summary says where else it fails and passes", () => {
  const dotnet = report("dotnet", [finding("LockTest.x", "always"), finding("Only.here", "failing")], ["LockTest.x", "Only.here"]);
  const java = report("java", [finding("LockTest.x", "always")], ["LockTest.x", "Only.here"]);
  const go = report("go", [], ["LockTest.x", "Only.here"]);
  crossCompare([dotnet, java, go], { java: "jvm" });
  assert.equal(dotnet.findings[0].crossSdk?.category, "mixed");
  assert.equal(dotnet.findings[1].crossSdk?.category, "only-this-sdk");
  assert.deepEqual(java.findings[0].crossSdk?.peers.map((x) => [x.sdk, x.status]), [["dotnet", "failing"], ["go", "passing"]]);
  assert.deepEqual(summariseCross(dotnet)[SERIES]["LockTest.x"], { category: "mixed", failingOn: ["java"], passingOn: ["go"] });
});
