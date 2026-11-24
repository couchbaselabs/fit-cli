/**
 * Bucketises a stream of per-operation results into one-second rows of buckets.csv.
 *
 * The output format, the bucketing rule, the 10-second lag and the end-of-run flush are all
 * fixed: these rows are the datapoints, and a difference here is a difference in every chart
 * built on them.
 *
 * Two things are done differently on purpose, both recorded in `working/fit-perf-decisions.md`:
 *
 * - **Percentiles are exact**, computed from the second's own samples, rather than through a
 *   HdrHistogram. HdrHistogram exists to bound memory over an unbounded
 *   stream; a single second's samples are already in memory here, so quantising them would
 *   only lose accuracy. Nearest-rank is used, matching HdrHistogram's convention.
 * - **Results are classified on arrival** rather than held whole and classified at write time.
 *   Classification is pure, so the rows are the same, but a run holds ten seconds of results at
 *   once and a compact record per operation is far cheaper than the whole protobuf message.
 */
import { closeSync, openSync, writeSync } from "node:fs";

/** Never write the most recent N seconds: results arrive out of order and in batches. */
export const IGNORE_MOST_RECENT_SECS_OF_DATA = 10;

export const BUCKETS_CSV_HEADER =
  "timestamp,timeOffsetSecs,total,success,failed,durationMinMicros,durationMaxMicros,durationAverageMicros,durationP50Micros,durationP95Micros,durationP99Micros,errors";

/** What one operation contributed to its second. */
export interface PerfSample {
  /** Wallclock second the operation was initiated in, i.e. its bucket key. */
  bucketSec: number;
  success: boolean;
  /** Only meaningful when `success`; failed operations are not timed. */
  elapsedNanos: number;
  /** Simple exception name, when the performer gave one. */
  errorName?: string;
}

export interface PerfBucketRow {
  timestamp: number;
  timeOffsetSecs: number;
  total: number;
  success: number;
  failed: number;
  durationMinMicros: number;
  durationMaxMicros: number;
  durationAverageMicros: number;
  durationP50Micros: number;
  durationP95Micros: number;
  durationP99Micros: number;
  errors: Record<string, number>;
}

/** RFC 4180 quoting, for fields that may contain a JSON blob. */
export function escapeCsv(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n") || field.includes("\r")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/**
 * Nearest-rank percentile over an ascending array of samples.
 *
 * `ceil(p/100 * n) - 1` is the index HdrHistogram's `getValueAtPercentile` resolves to, so
 * switching to exact values doesn't also switch convention.
 */
export function percentileNanos(sortedAscending: readonly number[], percentile: number): number {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const rank = Math.ceil((percentile / 100) * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index];
}

/** Nanoseconds to microseconds, truncating — the same conversion `TimeUnit` does. */
export function nanosToMicros(nanos: number): number {
  return Math.trunc(nanos / 1000);
}

/**
 * Java's `Instant.toString()` drops the fractional part when it is zero; JavaScript's
 * `toISOString()` always writes `.000`. The timestamp column has to match across engines.
 */
export function isoSecond(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(".000Z", "Z");
}

/** Turn one second's samples into its row. Pure, so it can be tested against known input. */
export function summariseBucket(firstTimestampSecs: number, timestampSecs: number, samples: readonly PerfSample[]): PerfBucketRow {
  const durations: number[] = [];
  const errors: Record<string, number> = {};
  let success = 0;
  let failed = 0;

  for (const sample of samples) {
    if (sample.success) {
      // Only successful operations are timed — a failure's elapsed time measures how long
      // the failure took, which isn't the latency of the operation under test.
      durations.push(sample.elapsedNanos);
      success += 1;
    } else {
      failed += 1;
      if (sample.errorName !== undefined) {
        errors[sample.errorName] = (errors[sample.errorName] ?? 0) + 1;
      }
    }
  }

  durations.sort((a, b) => a - b);
  const sum = durations.reduce((acc, value) => acc + value, 0);
  // Java takes the histogram's mean as a double and casts to long before converting, so the
  // truncation happens in nanoseconds, not microseconds.
  const meanNanos = durations.length === 0 ? 0 : Math.trunc(sum / durations.length);

  return {
    timestamp: timestampSecs,
    timeOffsetSecs: timestampSecs - firstTimestampSecs,
    // `total` is the count of *timed* operations, which is the successful ones. It reads like
    // success+failed and isn't; preserved as-is so rows stay comparable with the history.
    total: durations.length,
    success,
    failed,
    durationMinMicros: nanosToMicros(durations.length === 0 ? 0 : durations[0]),
    durationMaxMicros: nanosToMicros(durations.length === 0 ? 0 : durations[durations.length - 1]),
    durationAverageMicros: nanosToMicros(meanNanos),
    durationP50Micros: nanosToMicros(percentileNanos(durations, 50)),
    durationP95Micros: nanosToMicros(percentileNanos(durations, 95)),
    durationP99Micros: nanosToMicros(percentileNanos(durations, 99)),
    errors,
  };
}

/** Render one row in the order {@link BUCKETS_CSV_HEADER} declares. */
export function formatBucketRow(row: PerfBucketRow): string {
  const errors = Object.keys(row.errors).length === 0 ? "" : JSON.stringify(row.errors);
  return [
    isoSecond(row.timestamp),
    row.timeOffsetSecs,
    row.total,
    row.success,
    row.failed,
    row.durationMinMicros,
    row.durationMaxMicros,
    row.durationAverageMicros,
    row.durationP50Micros,
    row.durationP95Micros,
    row.durationP99Micros,
    escapeCsv(errors),
  ].join(",");
}

/**
 * Accumulates samples and writes completed one-second buckets to a CSV.
 *
 * Single-threaded, unlike the Java original: {@link add} does the bucketing inline and
 * {@link flushCompleted} is called on a timer rather than after every result, so the hot path
 * stays a map lookup and a push.
 */
export class PerfBucketWriter {
  private readonly buckets = new Map<number, PerfSample[]>();
  private readonly fd: number;
  private firstTimestampSecs = Number.MAX_SAFE_INTEGER;
  private rowsWritten = 0;

  constructor(readonly path: string) {
    this.fd = openSync(path, "w");
    writeSync(this.fd, `${BUCKETS_CSV_HEADER}\n`);
  }

  add(sample: PerfSample): void {
    const existing = this.buckets.get(sample.bucketSec);
    if (existing) existing.push(sample);
    else this.buckets.set(sample.bucketSec, [sample]);
  }

  /**
   * Write every bucket older than `ignoreMostRecentSecs`.
   *
   * Called periodically during the run to keep memory bounded, and once at the end with 0 to
   * write what's left. That final call is unconditional: a run shorter than the lag produces
   * no complete buckets at all, and gating it on there being new data is exactly the bug that
   * made short runs write nothing but a header.
   */
  flushCompleted(ignoreMostRecentSecs: number): void {
    if (this.buckets.size === 0) {
      return;
    }
    const keys = [...this.buckets.keys()].sort((a, b) => a - b);
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (last - first <= ignoreMostRecentSecs) {
      return;
    }

    // Seconds where the performer completed nothing still get a row, so a stall is visible
    // as a zero rather than as a gap in the series.
    for (let second = first; second < last; second++) {
      if (!this.buckets.has(second)) {
        this.buckets.set(second, []);
      }
    }

    const cutoff = last - ignoreMostRecentSecs;
    for (const second of [...this.buckets.keys()].sort((a, b) => a - b)) {
      if (second >= cutoff) {
        continue;
      }
      if (second < this.firstTimestampSecs) {
        this.firstTimestampSecs = second;
      }
      const samples = this.buckets.get(second) ?? [];
      this.write(summariseBucket(this.firstTimestampSecs, second, samples));
      this.buckets.delete(second);
    }
  }

  private write(row: PerfBucketRow): void {
    writeSync(this.fd, `${formatBucketRow(row)}\n`);
    this.rowsWritten += 1;
  }

  /** Flush everything remaining and close the file. Returns how many data rows were written. */
  close(): number {
    this.flushCompleted(0);
    closeSync(this.fd);
    return this.rowsWritten;
  }

  get rows(): number {
    return this.rowsWritten;
  }
}
