/**
 * Unit tests for the report's digest: the lists every view leads with.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/digest.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_RECORD_SCHEMA, addOutcome, type RunRecord } from "../../record/run-record.js";
import { buildHealthReport } from "../build-report.js";
import { testClass, testMethod } from "../digest.js";

let runId = 1;
function rec(date: string, failing: string[], over: Partial<RunRecord> = {}): RunRecord {
  const tests = {};
  for (const t of failing) addOutcome(tests, t, "f");
  addOutcome(tests, "Ok.passes", "p");
  return {
    schema: RUN_RECORD_SCHEMA,
    source: "run-archive-junit",
    sdk: "dotnet",
    preset: "op-onprem-func-lite",
    kind: "functional",
    cluster: "8.5-stable",
    params: {},
    date,
    ci: { repo: "r", runId: runId++, runAttempt: 1 },
    outcome: failing.length ? "tests_failed" : "passed",
    counts: { passed: 1, failed: failing.length, errored: 0, skipped: 0 },
    passesKnown: true,
    tests,
    ...over,
  };
}
const days = (n: number) => Array.from({ length: n }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);

test("a test id's class and method; a bare class name is a class-level error", () => {
  assert.deepEqual([testClass("LockTest.upsert"), testMethod("LockTest.upsert")], ["LockTest", "upsert"]);
  assert.deepEqual([testClass("LockTest"), testMethod("LockTest")], ["LockTest", "(whole class)"]);
});

test("started tests group by class, night and series, newest first, and situational series stay out", () => {
  const rs = days(28).flatMap((d, i) => [
    rec(d, [...(i >= 20 ? ["LockTest.a", "LockTest.b"] : []), ...(i >= 24 ? ["Other.c"] : [])]),
    rec(d, i >= 20 ? ["LockTest.a"] : [], { preset: "op-cng-func-lite" }),
    rec(d, i >= 20 ? ["Scenario.x"] : [], { preset: "op-capella-sit-lite", kind: "situational" }),
  ]);
  const { digest } = buildHealthReport("dotnet", rs, [], { end: "2026-09-28" });
  assert.deepEqual(
    digest.startedGroups.map((g) => [g.cls, g.tests, g.since, g.where]),
    [
      ["Other", ["Other.c"], "2026-09-25", "on-prem"],
      ["LockTest", ["LockTest.a", "LockTest.b"], "2026-09-21", "on-prem"],
      ["LockTest", ["LockTest.a"], "2026-09-21", "CNG"],
    ],
  );
  assert.deepEqual(digest.started, { total: 4, bySeries: [{ series: "on-prem", n: 3 }, { series: "CNG", n: 1 }] });
  assert.equal(digest.failingNow.total, 4);
});

test("the caveats cover only the classification window", () => {
  const bulk = { counts: { passed: 1, failed: 1, errored: 40, skipped: 0 } };
  const rs = Array.from({ length: 60 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
    return rec(d, ["A.x"], d === "2026-08-02" || d === "2026-09-20" ? bulk : {});
  });
  const report = buildHealthReport("dotnet", rs, [], { end: "2026-09-29" });
  assert.deepEqual(report.blackout, ["2026-08-02", "2026-09-20"]);
  assert.deepEqual(report.digest.gaps, ["2026-09-20"]);
});
