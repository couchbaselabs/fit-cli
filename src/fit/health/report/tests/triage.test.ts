/**
 * Unit tests for the triage report: the JSON contract for tools that act on a health report.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/triage.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_RECORD_SCHEMA, addOutcome, type RunRecord } from "../../record/run-record.js";
import { buildHealthReport } from "../build-report.js";
import { TRIAGE_SCHEMA, buildTriageReport, latestFailureRun } from "../triage.js";

let runId = 100;
function junit(date: string, outcomes: [string, "p" | "f" | "e"][], sha: string): RunRecord {
  const tests = {};
  for (const [t, o] of outcomes) addOutcome(tests, t, o);
  const failed = outcomes.filter(([, o]) => o !== "p").length;
  return {
    schema: RUN_RECORD_SCHEMA,
    source: "run-archive-junit",
    sdk: "dotnet",
    preset: "op-onprem-func-lite",
    kind: "functional",
    cluster: "8.5-stable",
    params: {},
    date,
    ci: { repo: "couchbase/couchbase-net-client", runId: runId++, runAttempt: 1, sha, job: "fit / op-onprem-func-lite" },
    outcome: failed ? "tests_failed" : "passed",
    counts: { passed: 100, failed, errored: 0, skipped: 0 },
    passesKnown: true,
    archive: { uri: `s3://fit-cli/runs/${date}.zip`, member: "runs/functional/surefire-reports.tar.gz" },
    tests,
  };
}

const days = (n: number) => Array.from({ length: n }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);

test("the latest failure run ignores unknown and not-run nights, and stops at a pass", () => {
  assert.deepEqual(latestFailureRun("ppffpfnuf"), { first: 5, last: 8 });
  assert.deepEqual(latestFailureRun("fppp"), { first: 0, last: 0 });
  assert.equal(latestFailureRun("pppn"), undefined);
});

test("a finding carries its classification, explicit history, and the evidence either side of the change", () => {
  // Passing to the 5th on sha "aaa", failing from the 6th on sha "bbb"; Other.y always passes.
  const rs = days(10).map((d, i) => junit(d, [["A.x", i < 5 ? "p" : "f"], ["Other.y", "p"]], i < 5 ? "aaa" : "bbb"));
  const report = buildHealthReport("dotnet", rs, [], { end: "2026-09-10" });
  const t = buildTriageReport(report, rs, { fixes: { "A.x": { ticket: "NCBC-1", text: "known" } } });
  assert.equal(t.schema, TRIAGE_SCHEMA);
  assert.equal(t.findings.length, 1, "only tests that aren't dormant");
  const f = t.findings[0];
  assert.deepEqual([f.test, f.class, f.method, f.classification.class, f.classification.since], ["A.x", "A", "x", "failing", "2026-09-06"]);
  assert.deepEqual([f.classification.lastPass, f.classification.lastRan], ["2026-09-05", "2026-09-10"]);
  assert.deepEqual(f.history.slice(4, 6), [{ date: "2026-09-05", outcome: "passed" }, { date: "2026-09-06", outcome: "failed" }]);
  assert.equal(f.evidence.lastGood?.date, "2026-09-05");
  assert.equal(f.evidence.firstFailing?.date, "2026-09-06");
  assert.equal(f.evidence.latestFailing?.date, "2026-09-10");
  assert.match(f.evidence.firstFailing?.run.url ?? "", /\/actions\/runs\/\d+\/attempts\/1$/);
  assert.equal(f.evidence.firstFailing?.archive?.uri, "s3://fit-cli/runs/2026-09-06.zip");
  assert.deepEqual(f.evidence.sdkChange, { from: "aaa", to: "bbb", changed: true, compareUrl: "https://github.com/couchbase/couchbase-net-client/compare/aaa...bbb" });
  assert.deepEqual(f.notes, { ticket: "NCBC-1", text: "known" });
  assert.equal(f.driverChanges, null);
  assert.equal(f.crossSdk, null);
});

test("an unchanged SDK commit across the change is said so, with no compare link", () => {
  const rs = days(10).map((d, i) => junit(d, [["A.x", i < 5 ? "p" : "f"]], "same"));
  const f = buildTriageReport(buildHealthReport("dotnet", rs, [], { end: "2026-09-10" }), rs).findings[0];
  assert.deepEqual(f.evidence.sdkChange, { from: "same", to: "same", changed: false });
});

test("a whole-class error has no method, and a not-run night says so", () => {
  const rs = days(6).map((d, i) => (i === 3 ? junit(d, [["Other.y", "p"]], "aaa") : junit(d, [["Disc.", i > 3 ? "e" : "p"], ["Disc.a", "p"]], "aaa")));
  const t = buildTriageReport(buildHealthReport("dotnet", rs, [], { end: "2026-09-06" }), rs);
  const f = t.findings.find((x) => x.test === "Disc")!;
  assert.equal(f.method, null);
  assert.equal(f.history[3].outcome, "not_run");
  assert.equal(f.history[4].outcome, "errored");
});
