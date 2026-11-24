/**
 * Summarise a perf run's result bundle for the end-of-run tables.
 *
 * Functional and situational runs have a test report to print — surefire XML, or the
 * test-driver's own scores — and the run tables key off that. A perf run has neither, so
 * it used to print "no test report available", which reads like something went wrong when
 * in fact hundreds of thousands of operations were measured successfully. It does have a
 * report; it just lives in `buckets.csv` and nothing rendered it.
 *
 * The percentiles here are summaries *of per-second percentiles*, not true percentiles over
 * the whole run: the bundle records one p50/p95/p99 per second, and the underlying histograms
 * are gone by the time we read it. Combining them exactly isn't possible, so the median
 * across seconds is reported as a typical second, alongside the worst second — and the column
 * headers say "per-sec" so nobody quotes these as run-wide percentiles. The bundle itself
 * remains the authority; this is orientation, not analysis.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** One second of a perf run, as recorded in `buckets.csv`. */
export interface PerfBucketRow {
  total: number;
  failed: number;
  p50Micros: number;
  p95Micros: number;
  p99Micros: number;
}

/** The summary of one result bundle — one row of the report table. */
export interface PerfBundleReport {
  label: string;
  seconds: number;
  total: number;
  failed: number;
  opsPerSec: number;
  /** Median across seconds; undefined when the run recorded no timed seconds. */
  p50Micros?: number;
  p95Micros?: number;
  p99Micros?: number;
  /** The worst single second's p99 — where a stall shows up that a median hides. */
  worstP99Micros?: number;
}

/** Parse `buckets.csv`, keeping only seconds that actually recorded operations. */
export function parsePerfBuckets(csv: string): PerfBucketRow[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = lines.shift();
  if (!header) return [];
  const columns = header.split(",");
  const indexOf = (name: string): number => columns.indexOf(name);
  const totalIdx = indexOf("total");
  const failedIdx = indexOf("failed");
  const p50Idx = indexOf("durationP50Micros");
  const p95Idx = indexOf("durationP95Micros");
  const p99Idx = indexOf("durationP99Micros");
  if (totalIdx < 0) return [];

  const rows: PerfBucketRow[] = [];
  for (const line of lines) {
    // errors is the last column and can itself contain commas, but every column we read
    // sits before it, so a plain split is safe here.
    const cells = line.split(",");
    const number = (idx: number): number => (idx < 0 ? 0 : Number(cells[idx] ?? 0) || 0);
    const total = number(totalIdx);
    if (total === 0) continue;
    rows.push({
      total,
      failed: number(failedIdx),
      p50Micros: number(p50Idx),
      p95Micros: number(p95Idx),
      p99Micros: number(p99Idx),
    });
  }
  return rows;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/** An `op:` value from a workload, which is untyped here because run.json5 carries it verbatim. */
function opName(value: unknown): string {
  return typeof value === "string" ? value : "?";
}

/**
 * A short name for what the bundle measured, from the `workload` block `run.json5` carries
 * verbatim (it is the datapoint's identity — see the header of run-perf-driver.ts). Falls
 * back to the bundle directory name, which is the run uuid's first 8 characters.
 */
export function workloadLabel(bundleDir: string): string {
  const runJson = join(bundleDir, "run.json5");
  if (!existsSync(runJson)) return basename(bundleDir);
  try {
    const parsed = JSON.parse(readFileSync(runJson, "utf8")) as Record<string, unknown>;
    const forDatabase = parsed.forDatabase as Record<string, unknown> | undefined;
    const workload = forDatabase?.workload as Record<string, unknown> | undefined;
    const operations = workload?.operations as readonly Record<string, unknown>[] | undefined;
    if (!operations || operations.length === 0) return basename(bundleDir);
    const names = operations.map((operation) => {
      const transaction = operation.transaction as Record<string, unknown> | undefined;
      if (transaction) {
        const ops = (transaction.ops as readonly Record<string, unknown>[] | undefined) ?? [];
        return `txn(${ops.map((o) => opName(o.op)).join("+")})`;
      }
      return opName(operation.op);
    });
    return names.join(", ");
  } catch {
    return basename(bundleDir);
  }
}

/** Summarise one bundle directory, or undefined when it recorded no timed seconds. */
export function summarisePerfBundle(bundleDir: string): PerfBundleReport | undefined {
  const bucketsCsv = join(bundleDir, "buckets.csv");
  if (!existsSync(bucketsCsv)) return undefined;
  const rows = parsePerfBuckets(readFileSync(bucketsCsv, "utf8"));
  if (rows.length === 0) return undefined;

  const total = rows.reduce((sum, r) => sum + r.total, 0);
  const failed = rows.reduce((sum, r) => sum + r.failed, 0);
  return {
    label: workloadLabel(bundleDir),
    seconds: rows.length,
    total,
    failed,
    // One row per second, so the row count is the measured duration.
    opsPerSec: Math.round(total / rows.length),
    p50Micros: median(rows.map((r) => r.p50Micros)),
    p95Micros: median(rows.map((r) => r.p95Micros)),
    p99Micros: median(rows.map((r) => r.p99Micros)),
    worstP99Micros: Math.max(...rows.map((r) => r.p99Micros)),
  };
}

/** Summarise every bundle a run produced, skipping any that recorded nothing. */
export function perfBundleReports(bundleDirs: readonly string[]): PerfBundleReport[] {
  return bundleDirs.map(summarisePerfBundle).filter((report): report is PerfBundleReport => report !== undefined);
}

const COLUMNS = ["Workload", "Secs", "Ops", "Failed", "Ops/sec", "p50 µs", "p95 µs", "p99 µs", "Worst p99 µs"] as const;

function cells(report: PerfBundleReport): string[] {
  const micros = (value: number | undefined): string => (value === undefined ? "-" : value.toLocaleString("en-US"));
  return [
    report.label,
    String(report.seconds),
    report.total.toLocaleString("en-US"),
    report.failed.toLocaleString("en-US"),
    report.opsPerSec.toLocaleString("en-US"),
    micros(report.p50Micros),
    micros(report.p95Micros),
    micros(report.p99Micros),
    micros(report.worstP99Micros),
  ];
}

/**
 * Said once under the table rather than crammed into every column header. Both halves matter:
 * the counts are lower than the "N results received" line the engine prints, because that counts
 * everything that came back while buckets.csv holds only fully-recorded seconds — and buckets.csv
 * is what becomes the datapoint, so it is the number worth showing.
 */
const PERCENTILE_NOTE =
  "From buckets.csv (one row per recorded second); percentiles are the median across those rows.";

/** Render a plain-text table: one row per result bundle. Mirrors renderScoresTable's shape. */
export function renderPerfReportTable(reports: readonly PerfBundleReport[]): string {
  if (reports.length === 0) return "";
  const rows = reports.map(cells);
  const widths = COLUMNS.map((column, i) => Math.max(column.length, ...rows.map((row) => row[i].length)));
  const line = (values: readonly string[]): string =>
    values.map((value, i) => (i === values.length - 1 ? value : value.padEnd(widths[i]))).join(" | ");

  return [
    line(COLUMNS),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...rows.map(line),
    PERCENTILE_NOTE,
  ].join("\n") + "\n";
}

/** Render the same table as {@link renderPerfReportTable}, as GFM markdown (for $GITHUB_STEP_SUMMARY). */
export function renderPerfReportMarkdownTable(reports: readonly PerfBundleReport[]): string {
  if (reports.length === 0) return "";
  return [
    `| ${COLUMNS.join(" | ")} |`,
    `| ${COLUMNS.map(() => "---").join(" | ")} |`,
    ...reports.map((report) => `| ${cells(report).join(" | ")} |`),
    "",
    `_${PERCENTILE_NOTE}_`,
  ].join("\n") + "\n";
}
