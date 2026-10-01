/**
 * Unit tests for working out which surefire report in a run archive belongs to which record.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/emit/tests/archive-junit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_RECORD_SCHEMA, type RunRecord } from "../../record/run-record.js";
import { needsArchiveUpgrade, MANIFEST_SCHEMA, MAX_FETCH_ATTEMPTS, type RunManifest } from "../../record/run-manifest.js";
import { matchTarball, uploadedArchivesByJob } from "../archive-junit.js";

const rec = (preset: string, kind: RunRecord["kind"], cluster?: string): RunRecord => ({
  schema: RUN_RECORD_SCHEMA,
  source: "run-log-scrape",
  sdk: "dotnet",
  preset,
  kind,
  cluster,
  params: {},
  date: "2026-08-05",
  ci: { repo: "r", runId: 1, runAttempt: 1, job: "run-dotnet-fit / run-fit-preset" },
  outcome: "tests_failed",
  counts: { passed: 1, failed: 0, errored: 0, skipped: 0 },
  passesKnown: false,
  tests: {},
});

// The single-job archive of 2026-08-05: every preset's reports in one zip.
const SINGLE_JOB = [
  "instances/aws1/clusters/8.0-stable/sessions/dotnet-main/runs/functional/surefire-reports.tar.gz",
  "instances/aws1/clusters/8.0.2-5503/sessions/dotnet-main/runs/functional/surefire-reports.tar.gz",
  "instances/aws1/clusterless-sessions/dotnet-main/runs/situational-standard-qe-v8.0/surefire-reports.tar.gz",
  "instances/aws1/clusterless-sessions/dotnet-main/runs/situational-standard-qe/surefire-reports.tar.gz",
];

test("functional runs sharing an archive are told apart by cluster", () => {
  const onprem = rec("op-onprem-func-lite", "functional", "8.0-stable");
  const cng = rec("op-cng-func-lite", "functional", "8.0.2-5503");
  const sit = rec("op-capella-sit-lite", "situational", "Capella:8.0");
  assert.deepEqual(matchTarball(onprem, SINGLE_JOB, [cng, sit]), { path: SINGLE_JOB[0] });
  assert.deepEqual(matchTarball(cng, SINGLE_JOB, [onprem, sit]), { path: SINGLE_JOB[1] });
});

test("situational presets sharing an archive are never guessed", () => {
  const capella = rec("op-capella-sit-lite", "situational", "Capella:8.0");
  const pe = rec("op-capella-pe-sit-lite", "situational", "Capella:8.0");
  const m = matchTarball(capella, SINGLE_JOB, [pe, rec("op-onprem-func-lite", "functional", "8.0-stable")]);
  assert.ok("reason" in m && /overwrite each other/.test(m.reason));
});

test("a job-per-preset archive holds one preset's reports", () => {
  const onlyPe = ["instances/aws1/clusterless-sessions/dotnet-main/runs/situational-standard-qe-v8.0/surefire-reports.tar.gz"];
  assert.deepEqual(matchTarball(rec("op-capella-pe-sit-lite", "situational", "Capella:8.0"), onlyPe, []), { path: onlyPe[0] });
});

test("two clusters of one preset (qe-set) each find their own report", () => {
  const tarballs = [
    "instances/aws1/clusters/8.0-stable/sessions/dotnet-main/runs/functional/surefire-reports.tar.gz",
    "instances/aws1/clusters/7.6-stable/sessions/dotnet-main/runs/functional/surefire-reports.tar.gz",
  ];
  const v80 = rec("qe-set", "functional", "8.0-stable");
  const v76 = rec("qe-set", "functional", "7.6-stable");
  assert.deepEqual(matchTarball(v76, tarballs, [v80]), { path: tarballs[1] });
});

test("each job's archive is found in the whole-run log", () => {
  const log = [
    "run-dotnet-fit / run-fit-preset\tRun\t2026-08-05T03:50:00.0Z [03:50:00] ✓ Uploaded run artifacts to s3://fit-cli/runs/20260805-002718-74a0.zip",
    "fit / op-cng-sit-lite\tRun\t2026-08-12T01:00:00.0Z [01:00:00] ✓ Uploaded run artifacts to s3://fit-cli/runs/20260812-001755-6bb3.zip",
  ].join("\n");
  assert.deepEqual(uploadedArchivesByJob(log), {
    "run-dotnet-fit / run-fit-preset": "s3://fit-cli/runs/20260805-002718-74a0.zip",
    "fit / op-cng-sit-lite": "s3://fit-cli/runs/20260812-001755-6bb3.zip",
  });
});

test("an archive upgrade is tried once; only a read error is retried, and only a few times", () => {
  const m = (archive?: RunManifest["archive"]): RunManifest => ({
    schema: MANIFEST_SCHEMA, sdk: "dotnet", runId: 1, runAttempt: 1, date: "2026-08-05", status: "ok", records: [], archive,
  });
  assert.equal(needsArchiveUpgrade(m()), true);
  assert.equal(needsArchiveUpgrade(m({ status: "partial", upgraded: [], skipped: [], attempts: 1 })), false);
  assert.equal(needsArchiveUpgrade(m({ status: "none", upgraded: [], skipped: [], attempts: 1 })), false);
  assert.equal(needsArchiveUpgrade(m({ status: "error", upgraded: [], skipped: [], attempts: 1 })), true);
  assert.equal(needsArchiveUpgrade(m({ status: "error", upgraded: [], skipped: [], attempts: MAX_FETCH_ATTEMPTS })), false);
});

test("an expired archive reads as missing: without ListBucket, S3 answers 403, not 404", async () => {
  const { isMissingObject } = await import("../../backfill/upgrade-from-archive.js");
  assert.equal(isMissingObject({ name: "NoSuchKey" }), true);
  assert.equal(isMissingObject({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }), true);
  assert.equal(isMissingObject({ $metadata: { httpStatusCode: 404 } }), true);
  assert.equal(isMissingObject({ name: "TimeoutError" }), false);
  assert.equal(isMissingObject({ $metadata: { httpStatusCode: 500 } }), false);
});

test("a Columnar run: its folder is functional-analytics, and its cluster label differs from the archive's", () => {
  const columnar = ["instances/aws1/clusters/Capella-cbdino1/sessions/columnar-java-main/runs/functional-analytics/surefire-reports.tar.gz"];
  const r = rec("columnar-func-lite", "functional", "CA-cbdino1");
  assert.deepEqual(matchTarball(r, columnar, []), { path: columnar[0] });
  // With another functional run in the same archive, a label that matches nothing is never guessed.
  const other = rec("op-onprem-func-lite", "functional", "8.5-stable");
  const two = [...columnar, "instances/aws1/clusters/8.5-stable/sessions/x/runs/functional/surefire-reports.tar.gz"];
  assert.ok("reason" in matchTarball(r, two, [other]));
});
