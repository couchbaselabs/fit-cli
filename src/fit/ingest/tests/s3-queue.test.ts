/**
 * Unit tests for grouping incoming S3 keys into run directories, and for the
 * status a whole ingester run reports.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/ingest/tests/s3-queue.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { overallStatus } from "../ingest.js";
import { groupIncomingKeys, type S3File } from "../s3-queue.js";

const at = (key: string): S3File => ({ key, lastModified: new Date(0) });

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
