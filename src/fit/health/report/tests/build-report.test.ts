/**
 * Unit tests for grouping run records into series and building the health report.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/build-report.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_RECORD_SCHEMA, addOutcome, type RunRecord } from "../../record/run-record.js";
import { buildHealthReport, presetWhere, reportFindings } from "../build-report.js";
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
  assert.equal(s.nights["2026-09-28"].sdkCommit, "sha2026-09-28");
});

test("a test already failing on the series' first night is failing since then, not started failing", () => {
  // couchbase-cxx-client's nightly began on 3 Oct, with tests that were already failing: the
  // history can't say when they started. A test that broke later in the same series did start.
  const rs = days(24, 28).map((d, i) => rec(d, { failing: ["Old.broken", ...(i >= 2 ? ["New.broke"] : [])] }));
  const report = buildHealthReport("dotnet", rs, [], { end: "2026-09-28", now: new Date("2026-09-28T12:00:00Z") });
  const [s] = report.series;
  const old = s.tests.find((t) => t.test === "Old.broken")!;
  assert.equal(old.cls, "failing");
  assert.equal(old.since, "2026-09-24");
  assert.equal(old.sinceFirstNight, true);
  assert.equal(s.tests.find((t) => t.test === "New.broke")!.sinceFirstNight, undefined);
  assert.deepEqual(s.started.map((t) => [t.test, t.since]), [["New.broke", "2026-09-26"]]);
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
  const scraped = rec("2026-09-02", { failing: ["A.x"], counts: { passed: 1002, failed: 1, errored: 0, skipped: 0 } });
  assert.deepEqual(nightTests(scraped), { testCases: 1003, failing: 1 });
  const [s] = buildHealthReport("dotnet", [junit, scraped], [], { end: "2026-09-02" }).series;
  assert.deepEqual(s.latest, { date: "2026-09-02", testCases: 1003, failing: 1, usable: true });
});

test("a night every preset ran but none could use is a blackout night too", () => {
  const bulk = { counts: { passed: 1, failed: 1, errored: 40, skipped: 0 } };
  const rs = days(1, 10).flatMap((d) => [
    rec(d, { failing: ["A.x"], ...(d === "2026-09-05" ? bulk : {}) }),
    rec(d, { preset: "op-cng-func-lite", failing: ["A.x"], ...(d === "2026-09-05" ? bulk : {}) }),
  ]);
  assert.deepEqual(buildHealthReport("dotnet", rs, [], { end: "2026-09-10" }).blackout, ["2026-09-05"]);
});

test("only presets whose latest night is the report's end, and usable, count as last night", () => {
  const junit = (d: string, preset: string, over: Partial<RunRecord> = {}) => {
    const tests = {};
    addOutcome(tests, "A.x", "p");
    return rec(d, { preset, source: "run-archive-junit", passesKnown: true, tests, ...over });
  };
  const rs = [
    ...days(1, 10).map((d) => junit(d, "op-onprem-func-lite")),
    ...days(1, 8).map((d) => junit(d, "op-cng-func-lite")), // missed the last two nights
  ];
  const r = buildHealthReport("dotnet", rs, [], { end: "2026-09-10" });
  const onprem = r.series.find((x) => x.preset === "op-onprem-func-lite")!;
  const cng = r.series.find((x) => x.preset === "op-cng-func-lite")!;
  assert.equal(onprem.latest?.usable, true);
  assert.deepEqual([cng.latest?.date, cng.latest?.usable], ["2026-09-08", false]);
  assert.deepEqual(r.digest.lastNight, { tests: 1, skipped: 0, testCases: 100, bySeries: [{ series: "on-prem", tests: 1 }] }, "CNG's older night isn't added in");
});

test("a log-only night naming a reused class's test makes each qualified test unknown, not a history of its own", () => {
  const junit = (d: string, o: "p" | "f") => {
    const tests = {};
    addOutcome(tests, "kv/GetTest.getX", o);
    addOutcome(tests, "states/GetTest.getX", "p");
    return rec(d, { source: "run-archive-junit", passesKnown: true, tests });
  };
  const rs = [junit("2026-09-01", "f"), rec("2026-09-02", { failing: ["GetTest.getX"] }), junit("2026-09-03", "f")];
  const h = testHistories(buildSeries(rs)[0]);
  assert.deepEqual(h.get("kv/GetTest.getX"), ["f", "u", "f"]);
  assert.deepEqual(h.get("states/GetTest.getX"), ["p", "u", "p"]);
  assert.equal(h.get("GetTest.getX"), undefined);
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

test("a test no longer followed still counts on the nights it failed", () => {
  // Failed on 1-3 Sep, then stopped running: by 28 Sep it's left out of the rows, but the
  // per-night counts (the trend chart, the night panel) still include those failures.
  const rs = days(1, 28).map((d, i) => rec(d, { failing: i < 3 ? ["Gone.test"] : [] }));
  for (const [i, r] of rs.entries()) if (i < 3) addOutcome(r.tests, "Other.p", "p");
  for (const [i, r] of rs.entries()) if (i >= 3) r.passesKnown = true;
  const report = buildHealthReport("dotnet", rs, [], { end: "2026-09-28", now: new Date("2026-09-28T12:00:00Z") });
  const [s] = report.series;
  assert.equal(s.tests.find((t) => t.test === "Gone.test"), undefined);
  assert.equal(s.stoppedRunningEarlier, 1);
  assert.deepEqual([s.perNight["2026-09-01"], s.perNight["2026-09-03"], s.perNight["2026-09-04"]], [1, 1, 0]);
});

test("records of one run told apart by a variant are separate series, named by it", () => {
  const rs = days(1, 5).flatMap((d) => [rec(d, { variant: "standard-qe" }), rec(d, { variant: "rebalance" })]);
  const report = buildHealthReport("dotnet", rs, [], { end: "2026-09-05", now: new Date("2026-09-05T12:00:00Z") });
  assert.equal(report.series.length, 2);
  assert.deepEqual(report.series.map((s) => s.label).sort(), ["Functional · on-prem · rebalance", "Functional · on-prem · standard-qe"]);
});

function junit(date: string, outcomes: [string, "p" | "f" | "e"][], sha: string): RunRecord {
  const tests = {};
  for (const [t, o] of outcomes) addOutcome(tests, t, o);
  const failed = outcomes.filter(([, o]) => o !== "p").length;
  return rec(date, {
    source: "run-archive-junit",
    ci: { repo: "couchbase/couchbase-net-client", runId: runId++, runAttempt: 1, sha, job: "fit / op-onprem-func-lite" },
    outcome: failed ? "tests_failed" : "passed",
    counts: { passed: 100, failed, errored: 0, skipped: 0 },
    passesKnown: true,
    archive: { uri: `s3://fit-cli/runs/${date}.zip`, member: "runs/functional/surefire-reports.tar.gz" },
    tests,
  });
}

test("a test carries its latest failure run and the nights either side, and each night its CI run and commit", () => {
  // Passing to the 5th on sha "aaa", failing from the 6th on sha "bbb"; Other.y always passes.
  const rs = days(1, 10).map((d, i) => junit(d, [["A.x", i < 5 ? "p" : "f"], ["Other.y", "p"]], i < 5 ? "aaa" : "bbb"));
  const report = buildHealthReport("dotnet", rs, [], { end: "2026-09-10", notes: { fixes: { "A.x": { ticket: "NCBC-1", text: "known" } } } });
  const [s] = report.series;
  const t = s.tests.find((x) => x.test === "A.x")!;
  assert.deepEqual([t.cls, t.since, t.lastPass, t.lastRan, t.lastGood], ["failing", "2026-09-06", "2026-09-05", "2026-09-10", "2026-09-05"]);
  assert.deepEqual(t.lastEpisode, { from: "2026-09-06", to: "2026-09-10", nights: 5 });
  assert.deepEqual(t.fix, { ticket: "NCBC-1", text: "known" });
  assert.equal(t.sdkChange, undefined, "looked up only by analyseChanges");
  const first = s.nights[t.lastEpisode.from];
  assert.equal(report.repo, "couchbase/couchbase-net-client");
  assert.equal(first.repo, undefined, "only a night in another repo names it");
  assert.equal(first.attempt, 1);
  assert.deepEqual([first.sdkCommit, first.sdkCommitFrom, first.archive?.uri, first.source], ["bbb", "workflow", "s3://fit-cli/runs/2026-09-06.zip", "run-archive-junit"]);
  assert.equal(s.nights[t.lastGood!].sdkCommit, "aaa");
  // Every test that ran in the window, for other SDKs' reports to say "it runs that test".
  assert.deepEqual(report.testsSeen.functional, { tests: ["A.x", "Other.y"], complete: true });
});

test("a whole-class error is a test named by its class; a night it didn't run doesn't break its failure run", () => {
  // The class errored as a whole every night it ran, and didn't run on the 4th.
  const rs = days(1, 6).map((d, i) => (i === 3 ? junit(d, [["Other.y", "p"]], "aaa") : junit(d, [["Disc.", "e"], ["Disc.a", "p"]], "aaa")));
  const [s] = buildHealthReport("dotnet", rs, [], { end: "2026-09-06" }).series;
  const t = s.tests.find((x) => x.test === "Disc")!;
  assert.equal(t.seq, "eeenee");
  assert.deepEqual(t.lastEpisode, { from: "2026-09-01", to: "2026-09-06", nights: 5 });
  assert.deepEqual([t.lastGood, t.previousNight], [undefined, undefined], "failing from the first night: no baseline");
});

test("the SDK commit under test is the performer image's revision, not the workflow's checkout", () => {
  // The workflow checked out a newer commit than the image, which was built the evening before.
  const rs = days(1, 4).map((d, i) => junit(d, [["A.x", i < 2 ? "p" : "f"]], i < 3 ? "old" : "merged-after-image"));
  const manifests = rs.map((r) => ({
    schema: 1 as const, sdk: "dotnet", runId: r.ci.runId, runAttempt: 1, date: r.date, ci: r.ci, status: "ok" as const, records: [],
    performerRevision: { "fit / op-onprem-func-lite": "image" },
  }));
  const [s] = buildHealthReport("dotnet", rs, manifests, { end: "2026-09-04" }).series;
  assert.deepEqual(s.nights["2026-09-04"], { ...s.nights["2026-09-04"], sdkCommit: "image", sdkCommitFrom: "performer-image", workflowCommit: "merged-after-image" });
  // Without the revision (older logs), the workflow's commit is used and says so.
  const [plain] = buildHealthReport("dotnet", rs, [], { end: "2026-09-04" }).series;
  assert.deepEqual([plain.nights["2026-09-04"].sdkCommit, plain.nights["2026-09-04"].sdkCommitFrom], ["merged-after-image", "workflow"]);
});

test("the tests a report follows up are those that aren't dormant, in series that are still active", () => {
  const rs = [
    ...days(1, 10).map((d, i) => rec(d, { failing: i >= 7 ? ["A.x"] : [] })),
    // A preset that last ran long before the window: shown, but not followed up.
    rec("2026-06-01", { preset: "op-cng-func-lite", failing: ["Old.y"] }),
  ];
  const report = buildHealthReport("dotnet", rs, [], { end: "2026-09-10", days: 120 });
  assert.deepEqual(report.series.map((s) => [s.preset, s.active]), [["op-onprem-func-lite", true], ["op-cng-func-lite", false]]);
  assert.deepEqual(reportFindings(report).map((f) => f.test.test), ["A.x"]);
});
