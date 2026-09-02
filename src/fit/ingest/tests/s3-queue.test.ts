/**
 * Unit tests for grouping incoming S3 keys into run directories, for the .done
 * marker that gates ingest, and for the status a whole ingester run reports.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/ingest/tests/s3-queue.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { overallStatus } from "../ingest.js";
import {
  groupIncomingKeys,
  hasDoneMarker,
  type IncomingRun,
  orderedForMove,
  runDataFilesByName,
  type S3File,
} from "../s3-queue.js";

const at = (key: string): S3File => ({ key, lastModified: new Date(0) });

const runOf = (...names: string[]): IncomingRun => ({
  sitSegment: "sit1",
  runSegment: "runA",
  files: names.map((n) => at(`incoming/sit1/runA/${n}`)),
});

test("groups files by sit/run directory", () => {
  const { runs, strayKeys } = groupIncomingKeys([
    at("incoming/sit1/runA/run.json5"),
    at("incoming/sit1/runA/buckets.csv"),
    at("incoming/sit1/runB/run.json5"),
    at("incoming/sit2/runC/run.json5"),
  ]);
  assert.deepEqual(strayKeys, []);
  assert.equal(runs.length, 3);
  const runA = runs.find((r) => r.runSegment === "runA");
  assert.equal(runA?.sitSegment, "sit1");
  assert.equal(runA?.files.length, 2);
});

test("treats keys not shaped like a run directory as stray", () => {
  const { runs, strayKeys } = groupIncomingKeys([
    at("incoming/loose-file.txt"),
    at("incoming/sit1/not-in-a-run-dir"),
    at("incoming/sit1/runA/run.json5"),
  ]);
  assert.equal(runs.length, 1);
  assert.deepEqual(strayKeys, ["incoming/loose-file.txt", "incoming/sit1/not-in-a-run-dir"]);
});

test("keeps nested extra files with their run", () => {
  const { runs } = groupIncomingKeys([at("incoming/sit1/runA/logs/driver.log")]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].files[0].key, "incoming/sit1/runA/logs/driver.log");
});

test("groups the marker with its run", () => {
  const { runs, strayKeys } = groupIncomingKeys([at("incoming/sit1/runA/run.json5"), at("incoming/sit1/runA/.done")]);
  assert.deepEqual(strayKeys, []);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].files.length, 2);
});

test("a run is ready only once it has the marker", () => {
  assert.equal(hasDoneMarker(runOf("run.json5", "buckets.csv", ".done")), true);
  assert.equal(hasDoneMarker(runOf("run.json5", "buckets.csv")), false);
  // Only the directory's own .done counts, not a lookalike or a nested one
  assert.equal(hasDoneMarker(runOf("run.json5", "notquite.done")), false);
  assert.equal(hasDoneMarker(runOf("run.json5", "logs/.done")), false);
});

test("the marker is not run data", () => {
  const byName = runDataFilesByName(runOf("run.json5", "buckets.csv", "logs/driver.log", ".done"));
  assert.deepEqual([...byName.keys()].sort(), ["buckets.csv", "logs/driver.log", "run.json5"]);
});

test("moves the marker with the rest of the directory, ahead of run.json5", () => {
  const keys = orderedForMove(runOf("run.json5", "buckets.csv", "metrics.csv", ".done").files).map((f) =>
    f.key.split("/").pop(),
  );
  assert.deepEqual(keys, ["buckets.csv", "metrics.csv", ".done", "run.json5"]);
});

const outcome = (o: "ingested" | "failed" | "deferred") => ({ sit: "s", run: "r", outcome: o });

test("reports nothing_to_do when no runs were seen", () => {
  assert.equal(overallStatus([]), "nothing_to_do");
});

test("reports success when everything was ingested", () => {
  assert.equal(overallStatus([outcome("ingested"), outcome("ingested")]), "success");
});

test("reports success for deferrals alone (uploads in flight are normal)", () => {
  assert.equal(overallStatus([outcome("ingested"), outcome("deferred")]), "success");
});

test("reports partial when any run failed", () => {
  assert.equal(overallStatus([outcome("ingested"), outcome("failed")]), "partial");
});
