/**
 * Unit tests for the health site's top page: each SDK's nights in the window.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/overview.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NightTests } from "../build-report.js";
import { buildOverview, layoutSections, nightTotals, placeSdk, productName, type OverviewInput } from "../overview.js";
import { HEALTH_OPT_INS } from "../../registry/health-opt-ins.js";
import { fillOverviewTemplate } from "../render/render-html.js";

const full = (passed: number, failing: number, skipped: number): NightTests => ({
  testCases: passed + failing + skipped,
  tests: passed + failing + skipped,
  passed,
  failing,
  skipped,
});
const logOnly = (failing: number): NightTests => ({ testCases: 500, failing });

/** A functional series with these nights; `more` makes it situational, inactive, and so on. */
const series = (testCounts: Record<string, NightTests>, more: Partial<OverviewInput["series"][number]> = {}): OverviewInput["series"][number] => ({
  kind: "functional",
  active: true,
  ran: Object.keys(testCounts).sort(),
  perNight: Object.fromEntries(Object.entries(testCounts).map(([d, c]) => [d, c.failing])),
  testCounts,
  ...more,
});

function input(sdk: string, start: string, end: string, nights: Record<string, NightTests>[]): OverviewInput {
  return { sdk, start, end, series: nights.map((testCounts) => series(testCounts)) };
}

test("nightTotals adds every series' night together", () => {
  const n = nightTotals([series({ "2026-09-30": full(100, 2, 10), "2026-10-01": full(100, 0, 10) }), series({ "2026-09-30": full(50, 1, 5) })]);
  assert.deepEqual(n.get("2026-09-30"), { date: "2026-09-30", passed: 150, failing: 3, skipped: 15, runs: 2, logOnly: 0, clean: false });
  assert.deepEqual(n.get("2026-10-01"), { date: "2026-10-01", passed: 100, failing: 0, skipped: 10, runs: 1, logOnly: 0, clean: false });
});

test("a log-only series counts its failures but not passes or skips", () => {
  const n = nightTotals([series({ "2026-09-30": full(100, 2, 10) }), series({ "2026-09-30": logOnly(4) })]);
  assert.deepEqual(n.get("2026-09-30"), { date: "2026-09-30", passed: 100, failing: 6, skipped: 10, runs: 2, logOnly: 1, clean: false });
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

test("a night that ran but gave no results is 'aborted' or 'unreadable', not 'none'", () => {
  const go = input("go", "2026-09-28", "2026-10-02", [{ "2026-09-28": full(10, 1, 0), "2026-09-30": full(10, 0, 0) }, { "2026-09-30": full(5, 0, 0) }]);
  // An abort on a night another series has results for leaves the night's counts.
  go.series[0].aborted = [{ date: "2026-09-29", runId: 1, attempt: 1 }];
  go.series[1].aborted = [{ date: "2026-09-30", runId: 2, attempt: 1 }, { date: "2026-10-01", runId: 3, attempt: 1 }];
  go.source = { unreadableRuns: [{ date: "2026-10-01", runId: 4, status: "parse_error" }, { date: "2026-10-02", runId: 5, status: "fetch_failed" }] };
  const o = buildOverview([{ input: go, name: "Go" }], [], new Date(), 5);
  assert.deepEqual(
    o.sdks[0].days.map((d) => (typeof d === "object" ? d.failing : d)),
    [1, "aborted", 0, "aborted", "unreadable"],
  );
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
  assert.deepEqual(o.missing, [{ sdk: "python", name: "Python", product: "SDK" }]);
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

test("an SDK goes in its language's row, in the section of that language's Couchbase SDK", () => {
  const optIns = { node: { family: "cxx" }, "insights-node": { language: "node" }, "columnar-java": { family: "jvm", language: "java" }, java: { family: "jvm" } };
  assert.deepEqual(placeSdk("node", optIns), { language: "node", product: "SDK", family: "cxx" });
  // insights-node is not built on the C++ core, but its row (Node.js) is in that section.
  assert.deepEqual(placeSdk("insights-node", optIns), { language: "node", product: "Operational Insights", family: "cxx" });
  assert.deepEqual(placeSdk("columnar-java", optIns), { language: "java", product: "Columnar", family: "jvm" });
  assert.deepEqual(placeSdk("insights-dotnet", { "insights-dotnet": { language: "dotnet" } }), { language: "dotnet", product: "Operational Insights", family: undefined });
  // Not opted in, or no language given: its own row, named after it.
  assert.deepEqual(placeSdk("go", {}), { language: "go", product: "SDK", family: undefined });
  assert.equal(productName("insights-go", "insights-go"), "Go Operational Insights");
});

test("the committed opt-ins lay out as core sections first, then the languages on their own", () => {
  const sdks = Object.keys(HEALTH_OPT_INS);
  const sections = layoutSections(sdks, (sdk) => placeSdk(sdk, HEALTH_OPT_INS));
  assert.deepEqual(
    sections.map((s) => [s.title ?? "", s.rows.map((r) => `${r.name}: ${r.sdks.join(" ")}`)]),
    [
      ["C++ core", ["C++: cpp", "Node.js: node insights-node", "Python: python insights-python"]],
      ["JVM", ["Java: java insights-java columnar-java", "Kotlin: kotlin", "Scala: scala"]],
      ["", [".NET: dotnet insights-dotnet"]],
      ["", ["Go: go insights-go"]],
    ],
  );
  assert.ok(sections[0].description);
});

test("an SDK with no report data keeps its place in its row", () => {
  const o = buildOverview(
    [{ input: input("dotnet", "2026-09-01", "2026-10-02", []), name: ".NET" }],
    [{ sdk: "insights-dotnet", name: ".NET Operational Insights" }],
    new Date(),
    3,
    { "insights-dotnet": { language: "dotnet" } },
  );
  assert.deepEqual(o.sections, [{ rows: [{ language: "dotnet", name: ".NET", sdks: ["dotnet", "insights-dotnet"] }] }]);
  assert.equal(o.missing[0].product, "Operational Insights");
  assert.equal(o.sdks[0].product, "SDK");
});

test("a report is marked carried over only when the site kept it, not when its nightly runs later", () => {
  const o = buildOverview([
    { input: input("dotnet", "2026-09-01", "2026-10-16", []), name: ".NET" },
    { input: input("insights-node", "2026-09-01", "2026-10-15", []), name: "Node.js Operational Insights" },
    { input: input("go", "2026-09-01", "2026-10-16", []), name: "Go", carried: true },
  ]);
  assert.deepEqual(o.sdks.map((s) => [s.sdk, s.carried ?? false]), [["dotnet", false], ["go", true], ["insights-node", false]]);
});

test("only the counted series add up: situational and inactive ones stay out", () => {
  const n = nightTotals([
    series({ "2026-09-30": full(100, 0, 10) }),
    series({ "2026-09-30": full(5, 3, 0) }, { kind: "situational" }),
    series({ "2026-09-30": full(40, 2, 0) }, { active: false }),
  ]);
  assert.deepEqual(n.get("2026-09-30"), { date: "2026-09-30", passed: 100, failing: 0, skipped: 10, runs: 1, logOnly: 0, clean: true });
  // A situational abort doesn't shade a night either.
  const go = input("go", "2026-09-29", "2026-09-29", []);
  go.series.push(series({}, { kind: "situational", aborted: [{ date: "2026-09-29", runId: 1, attempt: 1 }] }));
  assert.deepEqual(buildOverview([{ input: go, name: "Go" }], [], new Date(), 1).sdks[0].days, ["none"]);
});

test("an SDK's state is how its own latest night went", () => {
  const o = buildOverview(
    [
      { input: input("dotnet", "2026-09-01", "2026-10-02", [{ "2026-10-01": full(10, 1, 0), "2026-10-02": full(10, 0, 4) }]), name: ".NET" },
      { input: input("go", "2026-09-01", "2026-10-02", [{ "2026-10-02": full(10, 2, 0) }]), name: "Go" },
      // Ends a night early (its nightly runs later): judged on its own end, which is clean.
      { input: input("insights-go", "2026-09-01", "2026-10-01", [{ "2026-10-01": full(10, 0, 0) }]), name: "Go Operational Insights" },
      // Its last night came only from the CI log: no failures named, but not clean.
      { input: input("java", "2026-09-01", "2026-10-02", [{ "2026-10-02": logOnly(0) }]), name: "Java" },
      // Didn't run on its end date.
      { input: input("scala", "2026-09-01", "2026-10-02", [{ "2026-10-01": full(10, 0, 0) }]), name: "Scala" },
    ],
    [],
    new Date(),
    2,
  );
  assert.deepEqual(Object.fromEntries(o.sdks.map((s) => [s.sdk, s.state])), { dotnet: "clean", go: "failing", "insights-go": "clean", java: "none", scala: "none" });
  const dotnet = o.sdks.find((s) => s.sdk === "dotnet")!;
  assert.deepEqual(dotnet.days.map((d) => typeof d === "object" && d.clean), [false, true]);
});
