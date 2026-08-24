/**
 * End-to-end tests for the files-mode collect-and-upload step. Real filesystem,
 * real tar, real spawned processes - only the S3 upload is faked, since tests
 * can't write to the real bucket.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/functional/run-from-definition/tests/upload-collected-results.test.ts
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ensureRunDir } from "../../../../util/non-fit/replay.js";
import { run } from "../../../../util/non-fit/proc.js";
import { uploadCollectedResults, type ResultsCollector } from "../run-from-definition.js";
import { RESULTS_BUCKET } from "../../../situational/upload-results/upload-results.js";

/** A context whose methods really execute against the local filesystem. */
function realContext(kind: "local" | "remote"): ResultsCollector {
  return {
    kind,
    pathExists: (path) => Promise.resolve(existsSync(path)),
    runHiddenUntilFailure: (command, args) => run(command, args),
    collectFile: (targetPath, localPath) => {
      copyFileSync(targetPath, localPath);
      return Promise.resolve(localPath);
    },
    removeTree: (path) => {
      rmSync(path, { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}

/** One uploaded call's arguments plus what the uploaded directory contained. */
interface UploadReceipt {
  dir: string;
  bucket: string;
  id: string | undefined;
  runDirs: Record<string, string[]>;
}

function capturingUpload(receipts: UploadReceipt[]) {
  return (dir: string, bucket?: string, id?: string) => {
    const runDirs = Object.fromEntries(
      readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => [e.name, readdirSync(join(dir, e.name)).sort()]),
    );
    receipts.push({ dir, bucket: bucket ?? "", id, runDirs });
    return Promise.resolve({ artifacts: [], details: [] });
  };
}

/** Lay out a driver-style results dir: <base>/results/<uuid8>/{run.json5,buckets.csv}. */
function writeResultsDir(base: string): string {
  const resultsDir = join(base, "results");
  const runDir = join(resultsDir, "aaaaaaaa");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json5"), '{"forDatabase":{"runUuid":"aaaaaaaa-0000-4000-8000-000000000001"}}');
  writeFileSync(join(runDir, "buckets.csv"), "timestamp,total\n2026-08-24T00:00:00Z,1\n");
  return resultsDir;
}

function tempDirs(): { box: string; runDir: string } {
  const artifactRoot = ensureRunDir();
  mkdirSync(artifactRoot, { recursive: true });
  const base = mkdtempSync(join(artifactRoot, "collect-test-"));
  const runDir = join(base, "rundir");
  mkdirSync(runDir, { recursive: true });
  return { box: join(base, "box"), runDir };
}

test("remote happy path: archives, extracts, uploads the extracted copy, keeps only the tar", async () => {
  const { box, runDir } = tempDirs();
  const resultsDir = writeResultsDir(box);
  const receipts: UploadReceipt[] = [];

  const output = await uploadCollectedResults(realContext("remote"), resultsDir, runDir, "11111111-2222-4333-8444-555555555555", capturingUpload(receipts));

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.dir, join(runDir, "results"));
  assert.equal(receipts[0]?.bucket, RESULTS_BUCKET);
  assert.equal(receipts[0]?.id, "11111111-2222-4333-8444-555555555555");
  assert.deepEqual(receipts[0]?.runDirs, { aaaaaaaa: ["buckets.csv", "run.json5"] });
  // The tar is the artifact. The extracted tree and the remote tar are removed.
  assert.deepEqual(output.artifacts.map((a) => a.filename.endsWith("results.tar")), [true]);
  assert.ok(!existsSync(join(runDir, "results")));
  assert.ok(!existsSync(`${resultsDir}.tar`));
});

test("local happy path: uploads straight from the checkout, no archive made", async () => {
  const { box, runDir } = tempDirs();
  const resultsDir = writeResultsDir(box);
  const receipts: UploadReceipt[] = [];

  const output = await uploadCollectedResults(realContext("local"), resultsDir, runDir, "11111111-2222-4333-8444-555555555555", capturingUpload(receipts));

  assert.equal(receipts[0]?.dir, resultsDir);
  assert.equal(output.artifacts.length, 0);
  assert.ok(!existsSync(join(runDir, "results.tar")));
});

test("missing results dir: warns and uploads nothing", async () => {
  const { box, runDir } = tempDirs();
  const receipts: UploadReceipt[] = [];

  const output = await uploadCollectedResults(realContext("remote"), join(box, "results"), runDir, "11111111-2222-4333-8444-555555555555", capturingUpload(receipts));

  assert.equal(receipts.length, 0);
  assert.deepEqual(output, { artifacts: [], details: [] });
});

test("upload failure: the error propagates and the extracted copy stays for recovery", async () => {
  const { box, runDir } = tempDirs();
  const resultsDir = writeResultsDir(box);

  await assert.rejects(
    uploadCollectedResults(realContext("remote"), resultsDir, runDir, "11111111-2222-4333-8444-555555555555", () => Promise.reject(new Error("S3 says no"))),
    /S3 says no/,
  );

  // Both recovery copies survive: the extracted tree and the collected tar.
  assert.ok(existsSync(join(runDir, "results", "aaaaaaaa", "run.json5")));
  assert.ok(existsSync(join(runDir, "results.tar")));
  // The remote tar is still cleaned up.
  assert.ok(!existsSync(`${resultsDir}.tar`));
});

test("stale extraction and archives from a previous attempt are cleared, not re-uploaded", async () => {
  const { box, runDir } = tempDirs();
  const resultsDir = writeResultsDir(box);
  // Leftovers from a previous attempt: an extracted run directory and a kept-compressed archive.
  const staleRunDir = join(runDir, "results", "bbbbbbbb");
  mkdirSync(staleRunDir, { recursive: true });
  writeFileSync(join(staleRunDir, "run.json5"), '{"forDatabase":{"runUuid":"bbbbbbbb-0000-4000-8000-000000000002"}}');
  writeFileSync(join(runDir, "results.tar.gz"), "stale");
  const receipts: UploadReceipt[] = [];

  await uploadCollectedResults(realContext("remote"), resultsDir, runDir, "11111111-2222-4333-8444-555555555555", capturingUpload(receipts));

  // Only the fresh run was uploaded, and the stale archive is gone.
  assert.deepEqual(Object.keys(receipts[0]?.runDirs ?? {}), ["aaaaaaaa"]);
  assert.ok(!existsSync(join(runDir, "results.tar.gz")));
});
