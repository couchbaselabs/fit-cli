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
  assert.equal(digest.persistent.total, 4);
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

test("failed last night counts every test that failed on the end date, split by class", () => {
  // 30 nights. Broke.a: clean, then failing the last 4 nights (persistent). Flake.b: failed on
  // nights 10 and 20, and last night (intermittent). New.c: clean, then failed last night only
  // (new - in no other headline yet). Old.d: failed earlier and passes now (not counted).
  const rs = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
    const f = [
      ...(i >= 26 ? ["Broke.a"] : []),
      ...(i === 10 || i === 20 || i === 29 ? ["Flake.b"] : []),
      ...(i === 29 ? ["New.c"] : []),
      ...(i === 5 ? ["Old.d"] : []),
    ];
    // A JUnit record lists passes too: a test missing from it didn't run.
    const r = rec(d, f);
    for (const t of ["Broke.a", "Flake.b", "New.c", "Old.d"]) if (!f.includes(t)) addOutcome(r.tests, t, "p");
    return r;
  });
  const { digest } = buildHealthReport("dotnet", rs, [], { end: "2026-09-30" });
  const f = digest.failedLastNight!;
  assert.deepEqual([f.total, f.persistent, f.new, f.intermittent, f.atLeast], [3, 1, 1, 1, false]);
  assert.deepEqual(f.tests.map((t) => [t.test, t.cls]).sort(), [["Broke.a", "failing"], ["Flake.b", "intermittent"], ["New.c", "new"]]);
  assert.deepEqual(f.bySeries, [{ series: "on-prem", n: 3 }]);
  // The persistent count is the old "failing now": only Broke.a.
  assert.equal(digest.persistent.total, 1);
});

test("failed last night leaves out a series that didn't run then, and is a minimum when a night came from the log", () => {
  const rs = days(28).flatMap((d, i) => [
    rec(d, i === 27 ? ["A.x"] : [], i === 27 ? { source: "run-log-scrape", passesKnown: false } : {}),
    ...(i < 27 ? [rec(d, i === 26 ? ["B.y"] : [], { preset: "op-cng-func-lite" })] : []),
  ]);
  const { digest } = buildHealthReport("dotnet", rs, [], { end: "2026-09-28" });
  const f = digest.failedLastNight!;
  assert.deepEqual(f.bySeries, [{ series: "on-prem", n: 1 }]);
  assert.equal(f.total, 1);
  assert.equal(f.atLeast, true);
});

test("there is no failed-last-night count when no functional series ran on the end date", () => {
  const rs = days(10).map((d) => rec(d, []));
  const { digest } = buildHealthReport("dotnet", rs, [], { end: "2026-09-12" });
  assert.equal(digest.failedLastNight, undefined);
});

test("the clean nights are those every functional series passed with full results; situational ones don't count", () => {
  const rs = days(5).flatMap((d, i) => [
    rec(d, i === 1 ? ["A.x"] : [], i === 3 ? { source: "run-log-scrape", passesKnown: false } : {}),
    ...(i === 2 ? [] : [rec(d, [], { preset: "op-cng-func-lite" })]),
    rec(d, ["Scenario.s"], { preset: "op-capella-sit-lite", kind: "situational" }),
  ]);
  const { digest } = buildHealthReport("dotnet", rs, [], { end: "2026-09-05" });
  // 2: on-prem failed; 3: CNG didn't run; 4: on-prem only from the log.
  assert.deepEqual(digest.cleanNights, ["2026-09-01", "2026-09-05"]);
});
