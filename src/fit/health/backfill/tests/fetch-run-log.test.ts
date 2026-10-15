/**
 * Unit tests for turning per-job logs into the whole-run log the parser reads.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/backfill/tests/fetch-run-log.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRunLog } from "../../log-parse/parse-run-log.js";
import { hasLog, jobLogArgs, prefixJobLog } from "../fetch-run-log.js";

test("each line gets the job name and a step column, as gh run view --log prints it", () => {
  const out = prefixJobLog("fit / op-onprem-func-lite", "﻿2026-10-06T04:20:18Z one\r\n2026-10-06T04:20:19Z two\n");
  assert.equal(out, "fit / op-onprem-func-lite\tUNKNOWN STEP\t2026-10-06T04:20:18Z one\nfit / op-onprem-func-lite\tUNKNOWN STEP\t2026-10-06T04:20:19Z two");
});

test("a line over 64 KB is kept, and so is everything after it", () => {
  // gh run view --log stopped at such a line (a 100 KB serialized exception), losing the
  // rest of the job - including the line that names the run's S3 archive.
  const long = `2026-10-06T04:20:18Z serialized: "${"x".repeat(100_000)}"`;
  const upload = "2026-10-06T04:32:37Z [04:32:37] ✓ Uploaded run artifacts to s3://fit-cli/runs/20261006-033822-969d.zip";
  const lines = prefixJobLog("fit / op-onprem-func-lite", `${long}\n${upload}\n`).split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].length > 100_000);
  assert.ok(lines[1].endsWith("20261006-033822-969d.zip"));
});

test("the parser reads the joined jobs the same way it reads gh's whole-run log", () => {
  const tag = "[04:20:18·1/1·aws1·8.5-stable·python:main·functional]";
  const job = [
    "2026-10-06T04:20:18Z [04:20:18] Running preset op-onprem-func-lite",
    `2026-10-06T04:20:18Z ${tag} TOTAL | 1057 | 1404 | 8 | 2 | 99.06% | 18:00`,
  ].join("\n");
  const gh = job.split("\n").map((l) => `fit / op-onprem-func-lite\tRun fit\t${l}`).join("\n");
  const ours = prefixJobLog("fit / op-onprem-func-lite", job);
  const counts = (text: string) => parseRunLog(text).runs.map((r) => r.counts);
  assert.deepEqual(counts(ours), [{ passed: 1057, skipped: 1404, failed: 8, errored: 2 }]);
  assert.deepEqual(counts(ours), counts(gh));
});

test("a job GitHub skipped has no log to fetch; any other job does", () => {
  assert.equal(hasLog({ id: 1, name: "fit / aggregate-matrix-results", conclusion: "skipped" }), false);
  assert.equal(hasLog({ id: 2, name: "fit / op-capella-sit-lite", conclusion: "cancelled" }), true);
  assert.equal(hasLog({ id: 3, name: "fit / op-onprem-func-lite", conclusion: "failure" }), true);
});

test("the escape-sequence flag is passed only to a gh that has it", () => {
  // gh 2.97.0+ refuses a job log's colour codes without it; an older gh rejects the flag.
  assert.deepEqual(jobLogArgs("o/r", 7, true), ["api", "--allow-escape-sequences", "repos/o/r/actions/jobs/7/logs"]);
  assert.deepEqual(jobLogArgs("o/r", 7, false), ["api", "repos/o/r/actions/jobs/7/logs"]);
});
