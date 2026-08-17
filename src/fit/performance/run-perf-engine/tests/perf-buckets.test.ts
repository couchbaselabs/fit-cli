import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUCKETS_CSV_HEADER,
  IGNORE_MOST_RECENT_SECS_OF_DATA,
  PerfBucketWriter,
  escapeCsv,
  formatBucketRow,
  isoSecond,
  nanosToMicros,
  percentileNanos,
  summariseBucket,
  type PerfSample,
} from "../perf-buckets.js";

function tmpCsv(): string {
  return join(mkdtempSync(join(tmpdir(), "fit-perf-buckets-")), "buckets.csv");
}

function ok(bucketSec: number, elapsedNanos: number): PerfSample {
  return { bucketSec, success: true, elapsedNanos };
}

function failed(bucketSec: number, errorName?: string): PerfSample {
  return { bucketSec, success: false, elapsedNanos: -1, ...(errorName !== undefined ? { errorName } : {}) };
}

test("percentileNanos uses nearest rank, as HdrHistogram does", () => {
  const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  // ceil(50/100 * 10) - 1 = index 4
  assert.equal(percentileNanos(samples, 50), 50);
  assert.equal(percentileNanos(samples, 95), 100);
  assert.equal(percentileNanos(samples, 99), 100);
  assert.equal(percentileNanos(samples, 100), 100);
});

test("percentileNanos on a single sample returns it for every percentile", () => {
  assert.equal(percentileNanos([42], 50), 42);
  assert.equal(percentileNanos([42], 99), 42);
});

test("percentileNanos on no samples is zero, matching an empty histogram", () => {
  assert.equal(percentileNanos([], 50), 0);
});

test("nanosToMicros truncates rather than rounds", () => {
  assert.equal(nanosToMicros(20_999), 20);
  assert.equal(nanosToMicros(21_000), 21);
  assert.equal(nanosToMicros(0), 0);
});

test("isoSecond drops the fractional part, matching Java's Instant.toString", () => {
  assert.equal(isoSecond(1_755_188_461), "2025-08-14T16:21:01Z");
});

test("escapeCsv quotes only when it has to", () => {
  assert.equal(escapeCsv(""), "");
  assert.equal(escapeCsv("plain"), "plain");
  assert.equal(escapeCsv('{"a":1,"b":2}'), '"{""a"":1,""b"":2}"');
});

test("summariseBucket counts, times and offsets one second of results", () => {
  const row = summariseBucket(100, 105, [ok(105, 10_000), ok(105, 20_000), ok(105, 30_000), failed(105, "TimeoutException")]);
  assert.equal(row.timestamp, 105);
  assert.equal(row.timeOffsetSecs, 5);
  assert.equal(row.success, 3);
  assert.equal(row.failed, 1);
  assert.equal(row.durationMinMicros, 10);
  assert.equal(row.durationMaxMicros, 30);
  assert.equal(row.durationAverageMicros, 20);
  assert.deepEqual(row.errors, { TimeoutException: 1 });
});

test("summariseBucket's `total` is the timed (successful) count, not success+failed", () => {
  // A misleading name, kept: it is what the recorded history counted, and comparability
  // beats the better name.
  const row = summariseBucket(0, 0, [ok(0, 1_000), failed(0, "X"), failed(0, "X")]);
  assert.equal(row.total, 1);
  assert.equal(row.success, 1);
  assert.equal(row.failed, 2);
  assert.deepEqual(row.errors, { X: 2 });
});

test("summariseBucket only times successful operations", () => {
  const row = summariseBucket(0, 0, [ok(0, 5_000), failed(0, "Nope")]);
  assert.equal(row.durationMaxMicros, 5);
  assert.equal(row.durationAverageMicros, 5);
});

test("summariseBucket of an empty second is all zeros", () => {
  const row = summariseBucket(10, 12, []);
  assert.equal(row.total, 0);
  assert.equal(row.success, 0);
  assert.equal(row.failed, 0);
  assert.equal(row.durationMinMicros, 0);
  assert.equal(row.durationP99Micros, 0);
  assert.deepEqual(row.errors, {});
});

test("formatBucketRow writes the columns the header declares, in order", () => {
  const row = summariseBucket(1_755_188_461, 1_755_188_462, [ok(0, 1_500)]);
  const columns = formatBucketRow(row).split(",");
  assert.equal(columns.length, BUCKETS_CSV_HEADER.split(",").length);
  assert.equal(columns[0], "2025-08-14T16:21:02Z");
  assert.equal(columns[1], "1");
  assert.equal(columns[11], "");
});

test("formatBucketRow escapes the errors blob, which contains commas", () => {
  const row = summariseBucket(0, 0, [failed(0, "A"), failed(0, "B")]);
  const formatted = formatBucketRow(row);
  assert.ok(formatted.includes('"{""A"":1,""B"":1}"'), formatted);
});

test("the writer holds back the most recent seconds and writes the rest", () => {
  const path = tmpCsv();
  const writer = new PerfBucketWriter(path);
  for (let second = 0; second <= 20; second++) {
    writer.add(ok(second, 1_000));
  }
  writer.flushCompleted(IGNORE_MOST_RECENT_SECS_OF_DATA);
  // Seconds strictly before (20 - 10) are complete: 0..9.
  assert.equal(writer.rows, 10);
  writer.close();
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines[0], BUCKETS_CSV_HEADER);
  // The final flush writes everything except the newest second, which is still partial.
  assert.equal(lines.length - 1, 20);
});

test("a run shorter than the lag still writes its buckets at the end", () => {
  // The bug this guards: gating the final flush on there being new data meant a short
  // run wrote a header and nothing else, however many operations it completed.
  const path = tmpCsv();
  const writer = new PerfBucketWriter(path);
  for (let second = 0; second < 3; second++) {
    writer.add(ok(second, 2_000));
  }
  writer.flushCompleted(IGNORE_MOST_RECENT_SECS_OF_DATA);
  assert.equal(writer.rows, 0);
  const rows = writer.close();
  assert.equal(rows, 2);
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length - 1, 2);
});

test("seconds where nothing completed still get a row", () => {
  const path = tmpCsv();
  const writer = new PerfBucketWriter(path);
  writer.add(ok(0, 1_000));
  writer.add(ok(3, 1_000));
  writer.close();
  const lines = readFileSync(path, "utf8").trim().split("\n").slice(1);
  assert.equal(lines.length, 3);
  // The stalled seconds read as zeros rather than as a gap in the series.
  assert.equal(lines[1].split(",")[3], "0");
  assert.equal(lines[2].split(",")[3], "0");
});

test("timeOffsetSecs is measured from the first bucket ever written", () => {
  const path = tmpCsv();
  const writer = new PerfBucketWriter(path);
  writer.add(ok(1_000_000, 1_000));
  writer.add(ok(1_000_005, 1_000));
  writer.close();
  const offsets = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split(",")[1]);
  assert.deepEqual(offsets, ["0", "1", "2", "3", "4"]);
});
