/**
 * Unit tests for grouping run records into series and building the health report.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/build-report.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_RECORD_SCHEMA, addOutcome, type RunRecord } from "../../record/run-record.js";
import { buildHealthReport, presetWhere } from "../build-report.js";
import { buildSeries, testHistories } from "../series.js";

let runId = 1;
function rec(date: string, over: Partial<RunRecord> & { failing?: string[] } = {}): RunRecord {
  const { failing = [], ...rest } = over;
  const tests = {};
  for (const t of failing) addOutcome(tests, t, "f");
  return {
    schema: RUN_RECORD_SCHEMA,
    source: "run-log-scrape",
    sdk: "dotnet",
    preset: "op-onprem-func-lite",
    kind: "functional",
    cluster: "8.5-stable",
    params: { suite: "functional" },
    date,
    ci: { repo: "r", runId: runId++, runAttempt: 1, sha: `sha${date}` },
    outcome: failing.length ? "tests_failed" : "passed",
    counts: { passed: 100, failed: failing.length, errored: 0, skipped: 0 },
    passesKnown: false,
    tests,
    ...rest,
  };
}

const days = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `2026-09-${String(from + i).padStart(2, "0")}`);

test("a server-version change stays one series; two clusters on the same night split it", () => {
  const upgrade = [...days(1, 10).map((d) => rec(d, { cluster: "8.0-stable" })), ...days(11, 20).map((d) => rec(d))];
  assert.equal(buildSeries(upgrade).length, 1);

  const twoClusters = days(1, 5).flatMap((d) => [
    rec(d, { preset: "qe-set", cluster: "8.0-stable" }),
    rec(d, { preset: "qe-set", cluster: "7.6-stable" }),
  ]);
  assert.equal(buildSeries(twoClusters).length, 2);
});

test("presets are never merged, even with identical tags", () => {
  const rs = days(1, 5).flatMap((d) => [
    rec(d, { preset: "op-capella-sit-lite", kind: "situational", cluster: "Capella:8.0", params: { privateEndpoint: false } }),
    rec(d, { preset: "op-capella-pe-sit-lite", kind: "situational", cluster: "Capella:8.0", params: { privateEndpoint: true } }),
  ]);
  assert.equal(buildSeries(rs).length, 2);
});

test("an errored burst makes silences unknown; a named failure on it still counts", () => {
  const rs = [
    ...days(1, 9).map((d) => rec(d, { failing: ["A.x"] })),
    rec("2026-09-10", { failing: ["A.x"], counts: { passed: 60, failed: 1, errored: 40, skipped: 0 } }),
    ...days(11, 12).map((d) => rec(d, { failing: ["B.y"] })),
  ];
  const [s] = buildSeries(rs);
  assert.deepEqual(s.degraded, ["2026-09-10"]);
  const h = testHistories(s);
  assert.equal(h.get("A.x")![9], "f");
  assert.equal(h.get("B.y")![9], "u");
});

test("the report lists what started and stopped failing in the last two weeks", () => {
  const rs = days(1, 28).map((d, i) =>
    rec(d, { failing: [...(i >= 24 ? ["New.broke"] : []), ...(i >= 10 && i < 20 ? ["Old.fixed"] : [])] }),
  );
  const report = buildHealthReport("dotnet", rs, [], { end: "2026-09-28", now: new Date("2026-09-28T12:00:00Z") });
  const [s] = report.series;
  assert.deepEqual(s.started.map((t) => [t.test, t.since]), [["New.broke", "2026-09-25"]]);
  assert.deepEqual(s.stopped.map((t) => [t.test, t.last, t.run]), [["Old.fixed", "2026-09-20", 10]]);
  assert.equal(s.counts.failing, 1);
  assert.equal(s.counts.recovered, 1);
  assert.equal(report.commits["2026-09-28"], "sha2026-0", "commits are shortened to 9 characters");
});

test("two presets differing only by one run parameter are compared over the nights both ran", () => {
  const pub = (d: string, f: string[]) =>
    rec(d, { preset: "op-capella-sit-lite", kind: "situational", cluster: "Capella:8.0", params: { privateEndpoint: false }, failing: f });
  const pe = (d: string, f: string[]) =>
    rec(d, { preset: "op-capella-pe-sit-lite", kind: "situational", cluster: "Capella:8.0", params: { privateEndpoint: true }, failing: f });
  const rs = days(1, 20).flatMap((d, i) => [pub(d, i % 5 === 0 ? ["S.scale"] : []), pe(d, i % 2 === 0 ? ["S.scale"] : [])]);
  const report = buildHealthReport("dotnet", rs, [], { end: "2026-09-20" });
  assert.equal(report.comparisons.length, 1);
  const c = report.comparisons[0];
  assert.equal(c.param, "privateEndpoint");
  assert.match(c.b, /op-capella-pe-sit-lite/, "the parameter that is on goes second");
  // public red every 5th night, private endpoint every 2nd: both red on nights 0 and 10.
  assert.deepEqual([c.nights, c.aRed, c.bRed, c.bothRed], [20, 4, 10, 2]);
});

test("a night either preset can't use is left out of the comparison, not counted as green", () => {
  const sit = (preset: string, pe: boolean, d: string, over: Partial<RunRecord> = {}) =>
    rec(d, { preset, kind: "situational", cluster: "Capella:8.0", params: { privateEndpoint: pe }, failing: ["S.scale"], ...over });
  const rs = days(1, 10).flatMap((d) => [
    sit("op-capella-sit-lite", false, d),
    // The private-endpoint run errored in bulk on the 5th: unusable, whatever it named.
    sit("op-capella-pe-sit-lite", true, d, d === "2026-09-05" ? { counts: { passed: 1, failed: 1, errored: 40, skipped: 0 } } : {}),
  ]);
  const c = buildHealthReport("dotnet", rs, [], { end: "2026-09-10" }).comparisons[0];
  assert.deepEqual([c.nights, c.aRed, c.bRed, c.bothRed], [9, 9, 9, 9]);
  assert.deepEqual(c.rows.map((r) => [r.test, r.a.n, r.b.n]), [["S.scale", 9, 9]]);
});

test("a series that last ran before the window is not active", () => {
  const rs = [...days(1, 3).map((d) => rec(d, { preset: "qe-set", failing: ["A.x"] })), ...days(1, 28).map((d) => rec(d))];
  const report = buildHealthReport("dotnet", rs, [], { end: "2026-10-30" });
  assert.equal(report.series.find((s) => s.preset === "qe-set")!.active, false);
});

test("labels say where a preset runs", () => {
  assert.equal(presetWhere("op-capella-pe-sit-lite", {}), "Capella · private endpoint");
  assert.equal(presetWhere("op-capella-sit-lite", {}), "Capella · public endpoint");
  assert.equal(presetWhere("op-cng-func-lite", {}), "CNG");
  assert.equal(presetWhere("op-onprem-func-lite", {}), "on-prem");
  assert.equal(presetWhere("qe-set", {}), "qe-set preset");
});

test("on a scraped night that hid failures in a package, that package's unnamed tests are unknown", () => {
  const junit = (d: string) => rec(d, { source: "run-archive-junit", passesKnown: true, failing: ["LockTest.upsert"], packages: { LockTest: "com.couchbase.client.kv", GetTest: "com.couchbase.client.kv", Other: "x.y" } });
  const scrapedHidden = rec("2026-09-03", { failing: ["LockTest.getAndLock"], hiddenFailures: { "com.couchbase.client.kv": 2 } });
  const [s] = buildSeries([junit("2026-09-01"), junit("2026-09-02"), scrapedHidden]);
  const h = testHistories(s);
  assert.deepEqual(h.get("LockTest.upsert"), ["f", "f", "u"]);
});


test("in JUnit records a test passes only when listed as passing; skipped or gone is 'not run'", () => {
  const junit = (d: string, outcomes: [string, "p" | "f" | "s"][]) => {
    const tests = {};
    for (const [t, o] of outcomes) addOutcome(tests, t, o);
    return rec(d, { source: "run-archive-junit", passesKnown: true, tests });
  };
  const [s] = buildSeries([
    junit("2026-09-01", [["A.x", "f"], ["B.y", "p"]]),
    junit("2026-09-02", [["A.x", "p"], ["B.y", "p"]]),
    junit("2026-09-03", [["A.x", "s"], ["B.y", "p"]]),
    junit("2026-09-04", [["B.y", "p"]]),
    rec("2026-09-05"), // scraped: only failures are named, so the silence is an inferred pass
  ]);
  assert.deepEqual(testHistories(s).get("A.x"), ["f", "p", "n", "n", "p"]);
});

test("an errored test is recorded as errored, not failed", () => {
  const tests = {};
  addOutcome(tests, "A.x", "e");
  const [s] = buildSeries([rec("2026-09-01", { source: "run-archive-junit", passesKnown: true, tests, counts: { passed: 100, failed: 0, errored: 1, skipped: 0 } })]);
  assert.deepEqual(testHistories(s).get("A.x"), ["e"]);
});

test("a test that stopped running is listed for 14 days, then left out of the report", () => {
  const junit = (d: string, o: "f" | "s") => {
    const tests = {};
    addOutcome(tests, "Breaker.canaries", o);
    addOutcome(tests, "Other.ok", "p");
    return rec(d, { source: "run-archive-junit", passesKnown: true, tests });
  };
  // Failing to the 10th, skipped from the 11th.
  const rs = days(1, 28).map((d, i) => junit(d, i < 10 ? "f" : "s"));
  const recent = buildHealthReport("dotnet", rs.slice(0, 20), [], { end: "2026-09-20" }).series[0];
  assert.deepEqual(recent.stoppedRunning, [{ test: "Breaker.canaries", lastRan: "2026-09-10", lastResult: "f", since: "2026-09-11" }]);
  assert.equal(recent.tests.find((t) => t.test === "Breaker.canaries")?.cls, "stopped");
  assert.equal(recent.counts.failing, 0);
  const later = buildHealthReport("dotnet", rs, [], { end: "2026-09-28" }).series[0];
  assert.deepEqual(later.stoppedRunning, []);
  assert.equal(later.tests.length, 0);
  assert.equal(later.stoppedRunningEarlier, 1);
});

test("a whole class that errored gets its own row and makes the night red; no method is invented", () => {
  const junit = (d: string, outcomes: [string, "p" | "f" | "e"][]) => {
    const tests = {};
    for (const [t, o] of outcomes) addOutcome(tests, t, o);
    return rec(d, { source: "run-archive-junit", passesKnown: true, tests });
  };
  const rs = [
    junit("2026-09-01", [["Disconnect.a", "p"]]),
    rec("2026-09-02", { failing: ["Disconnect."], counts: { passed: 100, failed: 0, errored: 1, skipped: 0 } }), // scraped: 💥 Disconnect.
    junit("2026-09-03", [["Other.x", "p"]]), // the class didn't run at all
    rec("2026-09-04"), // scraped, silent: an inferred pass
  ];
  const [s] = buildSeries(rs);
  assert.deepEqual(testHistories(s).get("Disconnect"), ["p", "e", "n", "p"]);
  const report = buildHealthReport("dotnet", rs, [], { end: "2026-09-04" });
  assert.equal(report.series[0].perNight["2026-09-02"], 1);
});

test("the preset comparison counts a test only on nights each preset actually ran it", () => {
  const sit = (preset: string, pe: boolean, d: string, outcomes: [string, "p" | "f"][]) => {
    const tests = {};
    for (const [t, o] of outcomes) addOutcome(tests, t, o);
    return rec(d, { preset, kind: "situational", cluster: "Capella:8.0", params: { privateEndpoint: pe }, source: "run-archive-junit", passesKnown: true, tests });
  };
  // S.only fails on the public preset; the private-endpoint preset runs it on 2 of 4 nights.
  const rs = days(1, 4).flatMap((d, i) => [
    sit("op-capella-sit-lite", false, d, [["S.only", "f"], ["S.common", "p"]]),
    sit("op-capella-pe-sit-lite", true, d, i < 2 ? [["S.only", "p"], ["S.common", "p"]] : [["S.common", "p"]]),
  ]);
  const c = buildHealthReport("dotnet", rs, [], { end: "2026-09-04" }).comparisons[0];
  assert.deepEqual(c.rows.find((r) => r.test === "S.only"), { test: "S.only", a: { f: 4, n: 4 }, b: { f: 0, n: 2 } });
});

test("a night the nightly didn't run at all is a gap in the calendar and a blackout night", () => {
  const report = buildHealthReport("dotnet", [rec("2026-09-01"), rec("2026-09-03")], [], { end: "2026-09-05" });
  assert.deepEqual(report.dates, ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]);
  assert.deepEqual(report.blackout, ["2026-09-02", "2026-09-04", "2026-09-05"]);
});

test("a report looks at the last 90 days by default, or --days; older nights are left out entirely", () => {
  // 120 nights, A.x failing on the first 10 only (all before the 90-day window).
  const nights = Array.from({ length: 120 }, (_, i) => new Date(Date.parse("2026-06-02T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10));
  const rs = nights.map((d, i) => rec(d, { failing: i < 10 ? ["A.x"] : [] }));
  const old = { schema: 1, sdk: "dotnet", runId: 999, runAttempt: 1, date: nights[0], status: "expired" } as never;
  const r = buildHealthReport("dotnet", rs, [old], { end: nights.at(-1) });
  assert.equal(r.dates.length, 90);
  assert.equal(r.dates[0], nights[30]);
  assert.equal(r.source.records, 90);
  assert.deepEqual(r.source.unreadableRuns, [], "an unreadable run before the window isn't reported");
  assert.equal(r.series[0].tests.length, 0, "a test that only failed before the window isn't followed");
  const longer = buildHealthReport("dotnet", rs, [], { end: nights.at(-1), days: 120 });
  assert.equal(longer.dates.length, 120);
  assert.equal(longer.series[0].tests.find((t) => t.test === "A.x")?.fails, 10);
});

test("each night is counted in tests, not test cases; a log-only night says only what it can", async () => {
  const { nightTests } = await import("../build-report.js");
  const tests = {};
  addOutcome(tests, "Perm.permute", "f"); // one test that ran as 1,000 cases, 3 of them failing
  addOutcome(tests, "A.x", "p");
  addOutcome(tests, "A.y", "s");
  addOutcome(tests, "Broken.", "e");
  const junit = rec("2026-09-01", { source: "run-archive-junit", passesKnown: true, tests, counts: { passed: 998, failed: 3, errored: 1, skipped: 1 } });
  assert.deepEqual(nightTests(junit), { testCases: 1003, tests: 4, passed: 1, failing: 2, skipped: 1 });
  const scraped = rec("2026-09-02", { failing: ["A.x"] });
  assert.deepEqual(nightTests(scraped), { testCases: 101, failing: 1 });
  const [s] = buildHealthReport("dotnet", [junit, scraped], [], { end: "2026-09-02" }).series;
  assert.deepEqual(s.latest, { date: "2026-09-02", testCases: 101, failing: 1 });
});

test("notes files are validated: only known fixes, keyed by an exact test id, with text", async () => {
  const { validateNotes } = await import("../notes.js");
  assert.deepEqual(validateNotes({ fixes: { "SetAuthenticatorTest.canSetAuthenticator": { ticket: "NCBC-4304", text: "fixed" } } }), []);
  assert.ok(validateNotes({ crossSdk: {} }).some((p) => /unknown field "crossSdk"/.test(p)), "cross-SDK notes are gone for good");
  assert.ok(validateNotes({ fixes: { SetAuthenticatorTest: { text: "x" } } }).some((p) => /Class\.method/.test(p)));
  assert.ok(validateNotes({ fixes: { "A.b": {} } }).some((p) => /needs a text/.test(p)));
});

test("a re-run that replaces an aborted attempt doesn't split the preset's history by cluster", () => {
  // Attempt 1 died before any cluster ran (no cluster); attempt 2 ran on 8.0-stable. Later the
  // preset moved to 8.5-stable: still one series.
  const aborted = rec("2026-09-05", { cluster: undefined, outcome: "aborted", counts: undefined, ci: { repo: "r", runId: 900, runAttempt: 1 } });
  const rerun = rec("2026-09-05", { cluster: "8.0-stable", ci: { repo: "r", runId: 900, runAttempt: 2 } });
  const rs = [aborted, rerun, ...days(1, 4).map((d) => rec(d, { cluster: "8.0-stable" })), ...days(6, 20).map((d) => rec(d))];
  const series = buildSeries(rs);
  assert.equal(series.length, 1);
  assert.ok(series[0].ran.includes("2026-09-05"), "the re-run's results are the night's results");
  assert.deepEqual(series[0].aborted, []);
});

test("a preset that ran two clusters a night stays split, and a whole-preset abort counts against each cluster", () => {
  const rs = [
    ...days(1, 4).flatMap((d) => [rec(d, { preset: "qe-set", cluster: "8.0-stable" }), rec(d, { preset: "qe-set", cluster: "7.6-stable" })]),
    rec("2026-09-05", { preset: "qe-set", cluster: undefined, outcome: "aborted", counts: undefined }),
  ];
  const series = buildSeries(rs);
  assert.equal(series.length, 2);
  for (const s of series) assert.deepEqual(s.aborted.map((a) => a.date), ["2026-09-05"]);
});
