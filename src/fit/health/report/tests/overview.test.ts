/**
 * Unit tests for the health site's top page: each SDK's nights in the window.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/overview.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NightTests } from "../build-report.js";
import { buildOverview, nightTotals, type OverviewInput } from "../overview.js";
import { fillOverviewTemplate } from "../render/render-html.js";

const full = (passed: number, failing: number, skipped: number): NightTests => ({
  testCases: passed + failing + skipped,
  tests: passed + failing + skipped,
  passed,
  failing,
  skipped,
});
const logOnly = (failing: number): NightTests => ({ testCases: 500, failing });

function input(sdk: string, start: string, end: string, series: Record<string, NightTests>[]): OverviewInput {
  return { sdk, start, end, series: series.map((testCounts) => ({ testCounts })) };
}

test("nightTotals adds every series' night together", () => {
  const n = nightTotals([
    { testCounts: { "2026-09-30": full(100, 2, 10), "2026-10-01": full(100, 0, 10) } },
    { testCounts: { "2026-09-30": full(50, 1, 5) } },
  ]);
  assert.deepEqual(n.get("2026-09-30"), { date: "2026-09-30", passed: 150, failing: 3, skipped: 15, runs: 2, logOnly: 0 });
  assert.deepEqual(n.get("2026-10-01"), { date: "2026-10-01", passed: 100, failing: 0, skipped: 10, runs: 1, logOnly: 0 });
});

test("a log-only series counts its failures but not passes or skips", () => {
  const n = nightTotals([{ testCounts: { "2026-09-30": full(100, 2, 10) } }, { testCounts: { "2026-09-30": logOnly(4) } }]);
  assert.deepEqual(n.get("2026-09-30"), { date: "2026-09-30", passed: 100, failing: 6, skipped: 10, runs: 2, logOnly: 1 });
});

test("the window is the last N calendar days to the newest report's end", () => {
  const o = buildOverview(
    [
      { input: input("go", "2026-09-01", "2026-10-02", []), name: "Go" },
      { input: input("java", "2026-09-01", "2026-10-01", []), name: "Java" },
    ],
    [],
    new Date("2026-10-03T00:00:00Z"),
    5,
  );
  assert.equal(o.generatedAt, "2026-10-03T00:00:00.000Z");
  assert.deepEqual(o.dates, ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
});

test("a night with no run is 'none'; a night outside the report is 'unreported'", () => {
  const o = buildOverview(
    [
      {
        // Data starts inside the window, and the report (carried over) ends a night early.
        input: input("go", "2026-09-29", "2026-10-01", [{ "2026-09-29": full(10, 1, 0), "2026-10-01": full(10, 0, 0) }]),
        name: "Go",
      },
      { input: input("java", "2026-09-01", "2026-10-02", []), name: "Java" },
    ],
    [],
    new Date(),
    5,
  );
  const go = o.sdks.find((s) => s.sdk === "go")!;
  assert.deepEqual(
    go.days.map((d) => (typeof d === "object" ? d.failing : d)),
    ["unreported", 1, "none", 0, "unreported"],
  );
  assert.equal(go.latest?.date, "2026-10-01");
  const java = o.sdks.find((s) => s.sdk === "java")!;
  assert.deepEqual(java.days, ["none", "none", "none", "none", "none"]);
  assert.equal(java.latest, undefined);
});

test("latest is the newest night even when it is before the window", () => {
  const o = buildOverview([{ input: input("kotlin", "2026-08-01", "2026-10-02", [{ "2026-08-15": full(5, 1, 2) }]), name: "Kotlin" }], [], new Date(), 3);
  assert.equal(o.sdks[0].latest?.date, "2026-08-15");
});

test("SDKs are listed by name, not ranked; missing ones are kept for a link", () => {
  const o = buildOverview(
    [
      { input: input("scala", "2026-09-01", "2026-10-02", []), name: "Scala" },
      { input: input("dotnet", "2026-09-01", "2026-10-02", []), name: ".NET" },
      { input: input("go", "2026-09-01", "2026-10-02", []), name: "Go" },
    ],
    [{ sdk: "python", name: "Python" }],
  );
  assert.deepEqual(
    o.sdks.map((s) => s.sdk),
    ["dotnet", "go", "scala"],
  );
  assert.deepEqual(o.missing, [{ sdk: "python", name: "Python" }]);
});

test("no reports: an empty window, nothing to chart", () => {
  const o = buildOverview([], [{ sdk: "go", name: "Go" }]);
  assert.deepEqual(o.dates, []);
  assert.deepEqual(o.sdks, []);
});

test("the page embeds the data safely inside its script element", () => {
  const o = buildOverview([{ input: input("go", "2026-09-01", "2026-10-02", []), name: "</script><b>Go" }], [], new Date(), 2);
  const html = fillOverviewTemplate("<script>const D = /*__DATA__*/null;</script>", o);
  assert.ok(!html.includes("</script><b>"));
  assert.ok(html.includes("\\u003c/script>"));
  const json = html.slice("<script>const D = ".length, html.lastIndexOf(";</script>"));
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(o)));
});
