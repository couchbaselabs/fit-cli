/**
 * Unit tests for which series the headlines count, and when a night is clean.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/clean.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NightTests } from "../build-report.js";
import { cleanNights, isClean, isCounted, type CleanSeries } from "../clean.js";

const full = (passed: number, failing: number, skipped = 0): NightTests => ({ testCases: passed + failing + skipped, tests: passed + failing + skipped, passed, failing, skipped });
const logOnly = (failing: number): NightTests => ({ testCases: 500, failing });

/** A functional series with these nights; `more` makes it situational, inactive, and so on. */
const series = (testCounts: Record<string, NightTests>, more: Partial<CleanSeries> = {}): CleanSeries => ({
  kind: "functional",
  active: true,
  ran: Object.keys(testCounts).sort(),
  perNight: Object.fromEntries(Object.entries(testCounts).map(([d, c]) => [d, c.failing])),
  testCounts,
  ...more,
});

test("the counted series are the active functional ones", () => {
  assert.equal(isCounted({ kind: "functional", active: true }), true);
  assert.equal(isCounted({ kind: "situational", active: true }), false);
  assert.equal(isCounted({ kind: "functional", active: false }), false);
});

test("a night is clean when every counted series ran, gave full results and failed nothing", () => {
  const onprem = series({ d1: full(100, 0, 40), d2: full(100, 1) });
  const cng = series({ d1: full(50, 0), d2: full(50, 0) });
  assert.equal(isClean([onprem, cng], "d1"), true, "skipped tests don't spoil it");
  assert.equal(isClean([onprem, cng], "d2"), false, "one failure anywhere does");
});

test("a night is not clean when a counted series didn't run, or left only its log, or was degraded", () => {
  const onprem = series({ d1: full(100, 0), d2: full(100, 0), d3: full(100, 0) });
  assert.equal(isClean([onprem, series({ d1: full(50, 0), d3: full(50, 0) })], "d2"), false, "CNG didn't run");
  assert.equal(isClean([onprem, series({ d1: logOnly(0) })], "d1"), false, "passes unknown");
  assert.equal(isClean([series({ d1: full(100, 0) }, { perNight: { d1: null } })], "d1"), false, "degraded");
  assert.equal(isClean([onprem], "d9"), false, "no results at all");
});

test("a series that hadn't started yet isn't missing; situational series don't count either way", () => {
  const onprem = series({ d1: full(100, 0), d2: full(100, 0) });
  const cng = series({ d2: full(50, 0) });
  assert.equal(isClean([onprem, cng], "d1"), true);
  const capella = series({ d1: full(5, 3) }, { kind: "situational" });
  assert.equal(isClean([onprem, capella], "d1"), true);
  assert.equal(isClean([capella], "d1"), false, "nothing counted, nothing clean");
});

test("a series that aborted has started: before its first results, or with none at all", () => {
  const onprem = series({ d1: full(100, 0), d2: full(100, 0), d3: full(100, 0) });
  const abort = (date: string) => ({ date }) as NonNullable<CleanSeries["aborted"]>[number];
  const neverRan = series({}, { aborted: [abort("d2")] });
  assert.equal(isClean([onprem, neverRan], "d1"), true, "not started yet");
  assert.equal(isClean([onprem, neverRan], "d2"), false, "aborted, with no results ever");
  assert.equal(isClean([onprem, neverRan], "d3"), false, "started, and missing since");
  const lateFirst = series({ d3: full(50, 0) }, { aborted: [abort("d2")] });
  assert.equal(isClean([onprem, lateFirst], "d2"), false, "aborted before its first results");
  assert.equal(isClean([onprem, lateFirst], "d3"), true);
});

test("cleanNights keeps the clean ones, in order", () => {
  const s = [series({ d1: full(10, 0), d2: full(10, 2), d3: full(10, 0) })];
  assert.deepEqual(cleanNights(s, ["d1", "d2", "d3", "d4"]), ["d1", "d3"]);
});
