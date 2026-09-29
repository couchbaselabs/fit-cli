/**
 * Unit tests for listing an SDK's nightly runs.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/backfill/tests/list-runs.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { allAttempts, type CiRun } from "../list-runs.js";

const run = (runId: number, runAttempt: number): CiRun => ({
  runId,
  runAttempt,
  date: "2026-09-27",
  createdAt: "2026-09-27T00:00:00Z",
  workflow: "fit.yml",
  branch: "main",
  event: "schedule",
  sha: "abc",
  status: "completed",
  conclusion: "failure",
});

test("a re-run's earlier attempts are listed too: they hold the jobs that weren't re-run", () => {
  assert.deepEqual(
    allAttempts([run(7, 3), run(8, 1)]).map((r) => `${r.runId}#${r.runAttempt}`),
    ["7#3", "7#2", "7#1", "8#1"],
  );
});
