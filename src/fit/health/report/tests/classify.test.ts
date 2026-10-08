/**
 * Unit tests for turning a test's night-by-night history into a class.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/classify.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, episodes, lastEpisode, type NightOutcome } from "../classify.js";

const END = "2026-09-28";

/** One night per day ending at END, from a compact string like "pppff". */
function history(s: string, end = END): { dates: string[]; seq: NightOutcome[] } {
  const last = new Date(`${end}T00:00:00Z`);
  const dates = [...s].map((_, i) => {
    const d = new Date(last);
    d.setUTCDate(d.getUTCDate() - (s.length - 1 - i));
    return d.toISOString().slice(0, 10);
  });
  return { dates, seq: [...s] as NightOutcome[] };
}

const cls = (s: string, end = END) => {
  const h = history(s, end);
  return classify(h.dates, h.seq, END);
};

test("episodes are the unbroken runs of failures", () => {
  assert.deepEqual(episodes([..."ppffpfffp"] as ("p" | "f")[]), [2, 3]);
  assert.deepEqual(episodes([..."pppp"] as ("p" | "f")[]), []);
});

test("passing, then failing the last 4 nights, is failing - not intermittent", () => {
  const r = cls("p".repeat(26) + "ffff");
  assert.equal(r.cls, "failing");
  assert.equal(r.since, "2026-09-25");
  assert.equal(r.streak, 4);
});

test("failing 10 times on and off in a month is intermittent", () => {
  assert.equal(cls("pfpfppfpfpffpppfpfppfppfpppppp").cls, "intermittent");
});

test("a known flake that happens to fail three nights running stays intermittent", () => {
  assert.equal(cls("fpfpffpppfpppfpppppfpppppfpfff").cls, "intermittent");
});

test("a week straight is failing however flaky it was before", () => {
  assert.equal(cls("fpfpfpfpfpfpfpfpfpfpfp" + "fffffff").cls, "failing");
});

test("failing every night of the window is always; with too few nights it is only failing", () => {
  assert.equal(cls("f".repeat(30)).cls, "always");
  assert.equal(cls("f".repeat(5)).cls, "failing");
});

test("one or two new failures after a clean window are too early to call", () => {
  assert.equal(cls("p".repeat(28) + "ff").cls, "new");
});

test("recovered needs three clean nights; fewer keeps it failing, with the run's start date", () => {
  assert.equal(cls("p".repeat(20) + "fffff" + "ppp").cls, "recovered");
  const r = cls("p".repeat(20) + "fffff" + "pp");
  assert.equal(r.cls, "failing");
  assert.equal(r.since, "2026-09-22");
  assert.equal(r.cleanTail, 2);
});

test("a single short failure run, now passing, is a one-off", () => {
  assert.equal(cls("p".repeat(15) + "ff" + "p".repeat(13)).cls, "oneoff");
});

test("unknown nights neither pass nor break a streak", () => {
  const r = cls("p".repeat(20) + "ffufuf");
  assert.equal(r.cls, "failing");
  assert.equal(r.streak, 4);
});

test("the window is calendar days: a series that stopped running is judged on what it did recently", () => {
  // Failed on and off, then stopped running 40 days before the report ends.
  assert.equal(cls("pfpfpfpf", "2026-08-19").cls, "dormant");
});

test("old failures outside the window are reported on the calm classes", () => {
  const r = cls("f".repeat(20) + "p".repeat(30));
  assert.equal(r.cls, "dormant");
  assert.equal(r.flakyBefore, 20);
});

test("errored counts as a failure", () => {
  assert.equal(cls("p".repeat(20) + "eeee").cls, "failing");
  assert.equal(cls("e".repeat(14)).cls, "always");
});

test("a test that failed and then stopped running is 'stopped', with when it last ran and how", () => {
  // CircuitBreakerTest: failing for weeks, then skipped every night.
  const c = cls("f".repeat(10) + "nnnnn");
  assert.equal(c.cls, "stopped");
  assert.equal(c.since, undefined);
  const h = history("f".repeat(10) + "nnnnn");
  assert.deepEqual([c.lastRan, c.lastResult, c.notRunSince], [h.dates[9], "f", h.dates[10]]);
  // Unknown nights in the not-run tail don't hide that it stopped.
  assert.equal(cls("f".repeat(10) + "nnunn").cls, "stopped");
});

test("fewer than three nights not run is a gap, not 'stopped'; nor are skips mid-history", () => {
  assert.equal(cls("p".repeat(20) + "ffffnn").cls, "failing");
  assert.equal(cls("p".repeat(10) + "fffnnnnnfff").cls, "failing");
});

test("a test that only started running recently is judged from its first run", () => {
  // CustomMetadataCollectionTest: skipped for weeks, then errored every night it ran.
  const c = cls("n".repeat(16) + "e".repeat(14));
  assert.equal(c.cls, "always");
  assert.equal(c.windowRuns, 14);
});

test("the latest failure run ignores unknown and not-run nights, and stops at a pass", () => {
  const d = (n: number) => Array.from({ length: n }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
  assert.deepEqual(lastEpisode(d(9), [..."ppffpfnuf"] as NightOutcome[]), { lastEpisode: { from: "2026-09-06", to: "2026-09-09", nights: 2 }, lastGood: "2026-09-05" });
  // No pass before it: the night before is the baseline, if there is one.
  assert.deepEqual(lastEpisode(d(4), [..."nffp"] as NightOutcome[]), { lastEpisode: { from: "2026-09-02", to: "2026-09-03", nights: 2 }, previousNight: "2026-09-01" });
  assert.deepEqual(lastEpisode(d(2), [..."fp"] as NightOutcome[]), { lastEpisode: { from: "2026-09-01", to: "2026-09-01", nights: 1 } });
  assert.deepEqual(lastEpisode(d(4), [..."pppn"] as NightOutcome[]), {});
});
