/**
 * Unit tests for the weekly wrap-up: ISO weeks, how the failing set changed, and the cards.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/weekly.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NightTests, ReportTest } from "../build-report.js";
import type { TestClass } from "../classify.js";
import { buildWeekly, flakyIn, isoWeek, lastFullWeek, typicalTestsRun, weekChanges, type WeeklyInput } from "../weekly.js";

const W43 = isoWeek("2026-10-19");

const full = (passed: number, failing: number, skipped: number): NightTests => ({
  testCases: passed + failing + skipped,
  tests: passed + failing + skipped,
  passed,
  failing,
  skipped,
});

const t = (test: string, cls: TestClass, more: Partial<ReportTest> = {}) => ({ test, cls, streak: 0, ...more }) as ReportTest;

function report(end: string, tests: ReportTest[], testCounts: Record<string, NightTests> = {}, more: Partial<WeeklyInput["series"][number]> = {}): WeeklyInput {
  return {
    sdk: "go",
    start: "2026-07-01",
    end,
    series: [{ id: "func", short: "on-prem", kind: "functional", active: true, tests, testCounts, aborted: [], ...more }],
  };
}

const names = (xs: { test: string }[]) => xs.map((x) => x.test);

test("an ISO week runs Monday to Sunday and belongs to its Thursday's year", () => {
  assert.deepEqual(isoWeek("2026-10-19"), { id: "2026-W43", start: "2026-10-19", end: "2026-10-25" });
  assert.deepEqual(isoWeek("2026-10-25"), { id: "2026-W43", start: "2026-10-19", end: "2026-10-25" });
  assert.equal(isoWeek("2027-01-01").id, "2026-W53");
  assert.equal(isoWeek("2025-12-29").id, "2026-W01");
});

test("the last full week is the one that ended before today", () => {
  assert.equal(lastFullWeek("2026-10-26").id, "2026-W43"); // Monday: the week to yesterday
  assert.equal(lastFullWeek("2026-10-25").id, "2026-W42"); // Sunday: this week isn't over
});

test("a test joining the failing set is newly failing, marked if it never passed", () => {
  const before = report("2026-10-18", [t("A.already", "failing", { since: "2026-10-10", lastGood: "2026-10-09" })]);
  const now = report("2026-10-25", [
    t("A.already", "failing", { since: "2026-10-10", lastGood: "2026-10-09" }),
    t("A.broke", "failing", { since: "2026-10-21", streak: 5, lastGood: "2026-10-20" }),
    t("A.lastTwo", "new", { since: "2026-10-24", streak: 2, lastGood: "2026-10-23" }),
    t("A.neverPassed", "failing", { since: "2026-10-23", streak: 3, previousNight: "2026-10-22" }),
    t("A.flaky", "intermittent", { since: "2026-10-25", streak: 1, lastGood: "2026-10-24" }),
  ]);
  const c = weekChanges(now, before, W43);
  assert.deepEqual(names(c.newlyFailing), ["A.broke", "A.lastTwo", "A.neverPassed"]);
  assert.deepEqual(c.newlyFailing[0], { test: "A.broke", series: "func", where: "on-prem", since: "2026-10-21", nights: 5 });
  assert.equal(c.newlyFailing[2].neverPassed, true);
});

test("a failure run now passing, not yet recovered, gives the run's length and the clean nights since", () => {
  const now = report("2026-10-25", [
    t("A.passing", "failing", { since: "2026-10-19", streak: 0, cleanTail: 2, windowFails: 4, lastEpisode: { from: "2026-10-19", to: "2026-10-23", nights: 5 }, lastGood: "2026-10-18" }),
  ]);
  assert.deepEqual(weekChanges(now, report("2026-10-18", []), W43).newlyFailing, [
    { test: "A.passing", series: "func", where: "on-prem", since: "2026-10-19", nights: 5, passedLast: 2 },
  ]);
});

test("a test leaving the failing set is no longer failing, with why when it doesn't pass", () => {
  const before = report("2026-10-18", [
    t("A.fixed", "failing"),
    t("A.blip", "new"),
    t("A.flips", "failing"),
    t("A.gone", "always"),
    t("A.dropped", "failing"),
    t("A.still", "always"),
    t("A.wasFlaky", "intermittent"),
  ]);
  const now = report("2026-10-25", [
    t("A.fixed", "recovered", { lastFail: "2026-10-20" }),
    t("A.blip", "oneoff", { lastFail: "2026-10-18" }),
    t("A.flips", "intermittent", { lastFail: "2026-10-22" }),
    t("A.gone", "stopped", { lastFail: "2026-10-16" }),
    t("A.still", "always"),
    t("A.wasFlaky", "recovered"),
  ]);
  const c = weekChanges(now, before, W43);
  assert.deepEqual(
    c.noLongerFailing.map((x) => [x.test, x.last, x.why]),
    [
      ["A.fixed", "2026-10-20", undefined],
      ["A.blip", "2026-10-18", undefined],
      ["A.flips", "2026-10-22", "now flaky"],
      ["A.gone", "2026-10-16", "stopped running"],
      ["A.dropped", undefined, "not reported"],
    ],
  );
});

test("with no report for last week, only failure runs that began this week join", () => {
  const now = report("2026-10-25", [
    t("A.thisWeek", "failing", { since: "2026-10-21", lastGood: "2026-10-20" }),
    t("A.older", "always", { since: "2026-09-01" }),
    t("A.firstNight", "failing", { since: "2026-10-20", sinceFirstNight: true }),
  ]);
  const c = weekChanges(now, undefined, W43);
  assert.deepEqual(names(c.newlyFailing), ["A.thisWeek"]);
  assert.deepEqual(c.noLongerFailing, []);
});

test("situational and inactive series are left out", () => {
  const broke = [t("A.x", "failing", { since: "2026-10-21", lastGood: "2026-10-20" })];
  assert.deepEqual(weekChanges(report("2026-10-25", broke, {}, { kind: "situational" }), report("2026-10-18", []), W43).newlyFailing, []);
  assert.deepEqual(weekChanges(report("2026-10-25", broke, {}, { active: false }), report("2026-10-18", []), W43).newlyFailing, []);
});

test("tests run is the median night's, over JUnit nights only", () => {
  const night = (date: string, passed: number, logOnly = 0) => ({ date, passed, failing: 1, skipped: 5, runs: 1, logOnly });
  assert.equal(typicalTestsRun([night("a", 100), night("b", 300), night("c", 200), "none", night("d", 999, 1)]), 201);
  assert.equal(typicalTestsRun(["none", "aborted"]), undefined);
});

test("tests run counts the functional runs only, like failing", () => {
  const week = Object.fromEntries(["2026-10-19", "2026-10-20", "2026-10-21"].map((d) => [d, full(100, 2, 10)]));
  const big = Object.fromEntries(["2026-10-19", "2026-10-20", "2026-10-21"].map((d) => [d, full(900, 0, 0)]));
  const logOnly = { "2026-10-19": { testCases: 0, failing: 3 }, "2026-10-20": { testCases: 0, failing: 3 }, "2026-10-21": { testCases: 0, failing: 3 } } as Record<string, NightTests>;
  for (const counts of [big, logOnly]) {
    const now = report("2026-10-25", [], week);
    now.series.push({ id: "sit", short: "capella", kind: "situational", active: true, tests: [], testCounts: counts, aborted: [] });
    const c = buildWeekly([{ sdk: "go", name: "Go", current: now }], W43).cards[0];
    assert.equal(c.testsRun, 102);
    assert.equal(c.nightsWithResults, 3, "the night strip still shows every run");
  }
});

test("flaky is the intermittent tests that failed during the week, apart from failing", () => {
  const now = report("2026-10-25", [
    t("A.flips", "intermittent", { lastFail: "2026-10-22" }),
    t("A.flippedBefore", "intermittent", { lastFail: "2026-10-15" }),
    t("A.broke", "failing", { lastFail: "2026-10-25" }),
  ]);
  assert.deepEqual(flakyIn(now, W43), [{ test: "A.flips", series: "func", where: "on-prem", last: "2026-10-22" }]);
});

test("a card: failing at both week ends, what joined and left, and the nights", () => {
  const week = Object.fromEntries(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"].map((d) => [d, full(100, 2, 10)]));
  const before = report("2026-10-18", [t("A.fixed", "failing"), t("A.still", "always"), t("A.gone", "always")]);
  const now = report(
    "2026-10-25",
    [
      t("A.fixed", "recovered", { lastFail: "2026-10-19" }),
      t("A.still", "always"),
      t("A.gone", "stopped"),
      t("A.broke", "failing", { since: "2026-10-21", streak: 3, lastGood: "2026-10-20" }),
      t("A.lastTwo", "new", { since: "2026-10-24", streak: 2, lastGood: "2026-10-23" }),
      t("A.added", "failing", { since: "2026-10-22", streak: 4, previousNight: "2026-10-21" }),
    ],
    week,
  );
  const w = buildWeekly([{ sdk: "go", name: "Go", current: now, previous: before }], W43, new Date("2026-10-26T12:00:00Z"));
  assert.equal(w.previous.id, "2026-W42");
  assert.deepEqual(w.dates, ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
  const c = w.cards[0];
  assert.equal(c.failingBefore, 3);
  assert.equal(c.failing, 4);
  assert.deepEqual(names(c.newlyFailing), ["A.broke", "A.lastTwo", "A.added"]);
  assert.deepEqual(names(c.noLongerFailing), ["A.fixed", "A.gone"]);
  assert.equal(c.nightsWithResults, 5);
  assert.equal(c.testsRun, 102);
  assert.deepEqual(c.days.slice(5), ["none", "none"]);
  assert.equal(c.noChange, false);
});

test("a card with nothing joining or leaving, every night run, is 'No change'", () => {
  const week = Object.fromEntries(Array.from({ length: 7 }, (_, k) => [`2026-10-${19 + k}`, full(100, 1, 0)]));
  const r = (end: string) => report(end, [t("A.still", "always")], week);
  const w = buildWeekly([{ sdk: "go", name: "Go", current: r("2026-10-25"), previous: r("2026-10-18") }], W43);
  assert.equal(w.cards[0].noChange, true);
});

test("an SDK with no report has a card with no results all week", () => {
  const w = buildWeekly([{ sdk: "rust", name: "Rust" }], W43);
  const card = w.cards[0];
  assert.equal(card.reported, false);
  assert.equal(card.nightsWithResults, 0);
  assert.equal(card.noChange, false);
  assert.equal(card.failingBefore, undefined);
  assert.deepEqual(card.flaky, []);
});
