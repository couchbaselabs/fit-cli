import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePerfBuckets,
  perfBundleReports,
  renderPerfReportMarkdownTable,
  renderPerfReportTable,
  summarisePerfBundle,
  workloadLabel,
} from "../perf-report.js";

const HEADER =
  "timestamp,timeOffsetSecs,total,success,failed,durationMinMicros,durationMaxMicros,durationAverageMicros," +
  "durationP50Micros,durationP95Micros,durationP99Micros,errors";

/** One buckets.csv row, in the real column order. */
function row(total: number, failed: number, p50: number, p95: number, p99: number): string {
  return `2026-08-17T10:53:20Z,0,${total},${total - failed},${failed},17,1846,43,${p50},${p95},${p99},`;
}

function bundle(rows: readonly string[], runJson?: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "fit-perf-report-")), "1538ca0b");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "buckets.csv"), [HEADER, ...rows].join("\n") + "\n");
  if (runJson !== undefined) writeFileSync(join(dir, "run.json5"), runJson);
  return dir;
}

test("parsePerfBuckets reads columns by name, not position", () => {
  const rows = parsePerfBuckets([HEADER, row(100, 2, 31, 93, 240)].join("\n"));
  assert.deepEqual(rows, [{ total: 100, failed: 2, p50Micros: 31, p95Micros: 93, p99Micros: 240 }]);
});

test("parsePerfBuckets drops seconds that recorded no operations", () => {
  // A zero-op second is real (the ramp-up second, or a stall) but has no percentiles to
  // contribute; averaging its zeroes in would drag every latency figure towards zero.
  const rows = parsePerfBuckets([HEADER, row(0, 0, 0, 0, 0), row(100, 0, 31, 93, 240)].join("\n"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 100);
});

test("parsePerfBuckets returns nothing for a header-only file", () => {
  // The exact failure assessPerfBundles exists to catch — the report must not invent a row.
  assert.deepEqual(parsePerfBuckets(HEADER + "\n"), []);
});

test("summarisePerfBundle averages throughput over seconds and takes median percentiles", () => {
  const report = summarisePerfBundle(bundle([row(100, 0, 10, 50, 100), row(300, 1, 30, 70, 900), row(200, 0, 20, 60, 200)]))!;
  assert.equal(report.seconds, 3);
  assert.equal(report.total, 600);
  assert.equal(report.failed, 1);
  assert.equal(report.opsPerSec, 200);
  assert.equal(report.p50Micros, 20);
  assert.equal(report.p95Micros, 60);
  // Median p99, not mean: the 900µs second is one stall, and it belongs in worstP99 instead.
  assert.equal(report.p99Micros, 200);
  assert.equal(report.worstP99Micros, 900);
});

test("summarisePerfBundle returns undefined when nothing was measured", () => {
  assert.equal(summarisePerfBundle(bundle([])), undefined);
  assert.equal(summarisePerfBundle(join(tmpdir(), "does-not-exist-fit-perf")), undefined);
});

test("workloadLabel names the operations from run.json5", () => {
  const dir = bundle([row(100, 0, 10, 50, 100)], JSON.stringify({ forDatabase: { workload: { operations: [{ op: "get" }] } } }));
  assert.equal(workloadLabel(dir), "get");
});

test("workloadLabel spells out a transaction's inner ops", () => {
  const workload = { operations: [{ transaction: { ops: [{ op: "replace" }, { op: "insert" }] } }] };
  const dir = bundle([row(100, 0, 10, 50, 100)], JSON.stringify({ forDatabase: { workload } }));
  assert.equal(workloadLabel(dir), "txn(replace+insert)");
});

test("workloadLabel falls back to the bundle name when run.json5 is missing or unreadable", () => {
  assert.equal(workloadLabel(bundle([row(100, 0, 10, 50, 100)])), "1538ca0b");
  assert.equal(workloadLabel(bundle([row(100, 0, 10, 50, 100)], "{not json")), "1538ca0b");
});

test("renderPerfReportTable renders a row per bundle and says what the percentiles are", () => {
  const dir = bundle([row(100, 0, 10, 50, 100)], JSON.stringify({ forDatabase: { workload: { operations: [{ op: "get" }] } } }));
  const table = renderPerfReportTable(perfBundleReports([dir]));
  assert.match(table, /Workload \| Secs \| Ops/);
  assert.match(table, /^get\s+\| 1\s+\| 100/m);
  // The caveat is load-bearing: these are medians of per-second percentiles, over recorded
  // seconds only — so the counts are legitimately lower than the engine's "results received".
  assert.match(table, /From buckets\.csv .*median across those rows/);
});

test("renderPerfReportTable and its markdown twin are empty when there is nothing to report", () => {
  assert.equal(renderPerfReportTable([]), "");
  assert.equal(renderPerfReportMarkdownTable([]), "");
});

test("renderPerfReportMarkdownTable emits a GFM table", () => {
  const dir = bundle([row(100, 0, 10, 50, 100)], JSON.stringify({ forDatabase: { workload: { operations: [{ op: "get" }] } } }));
  const markdown = renderPerfReportMarkdownTable(perfBundleReports([dir]));
  assert.match(markdown, /^\| Workload \| Secs \|/m);
  assert.match(markdown, /^\| --- \| --- \|/m);
  assert.match(markdown, /^\| get \| 1 \| 100 \|/m);
});
