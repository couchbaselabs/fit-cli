/**
 * End-to-end tests for the files-mode collect-and-upload step. Real filesystem,
 * real tar, real spawned processes - only the S3 upload is faked, since tests
 * can't write to the real bucket.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/functional/run-from-definition/tests/upload-collected-results.test.ts
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ensureRunDir } from "../../../../util/non-fit/replay.js";
import { run } from "../../../../util/non-fit/proc.js";
import {
  needsResultsUpload,
  publishPerfResults,
  runsPerfRemotely,
  uploadCollectedResults,
  type ResultsCollector,
  type ResultsPublishing,
} from "../run-from-definition.js";
import { RESULTS_BUCKET } from "../../../situational/upload-results/upload-results.js";

/** Publishing needs `--results-upload`, so the upload tests opt in explicitly. */
const UPLOAD = { resultsUpload: true };

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
  return (dir: string, bucket?: string, opts?: { assertId?: string; fallbackId?: string }) => {
    const id = opts?.fallbackId ?? opts?.assertId;
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

  const output = await uploadCollectedResults(realContext("remote"), resultsDir, runDir, "11111111-2222-4333-8444-555555555555", capturingUpload(receipts), UPLOAD);

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

  const output = await uploadCollectedResults(realContext("local"), resultsDir, runDir, "11111111-2222-4333-8444-555555555555", capturingUpload(receipts), UPLOAD);

  assert.equal(receipts[0]?.dir, resultsDir);
  assert.equal(output.artifacts.length, 0);
  assert.ok(!existsSync(join(runDir, "results.tar")));
});

test("missing results dir: warns and uploads nothing", async () => {
  const { box, runDir } = tempDirs();
  const receipts: UploadReceipt[] = [];

  const output = await uploadCollectedResults(realContext("remote"), join(box, "results"), runDir, "11111111-2222-4333-8444-555555555555", capturingUpload(receipts), UPLOAD);

  assert.equal(receipts.length, 0);
  assert.deepEqual(output, { artifacts: [], details: [] });
});

test("upload failure: the error propagates and the extracted copy stays for recovery", async () => {
  const { box, runDir } = tempDirs();
  const resultsDir = writeResultsDir(box);

  await assert.rejects(
    uploadCollectedResults(realContext("remote"), resultsDir, runDir, "11111111-2222-4333-8444-555555555555", () => Promise.reject(new Error("S3 says no")), UPLOAD),
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

  await uploadCollectedResults(realContext("remote"), resultsDir, runDir, "11111111-2222-4333-8444-555555555555", capturingUpload(receipts), UPLOAD);

  // Only the fresh run was uploaded, and the stale archive is gone.
  assert.deepEqual(Object.keys(receipts[0]?.runDirs ?? {}), ["aaaaaaaa"]);
  assert.ok(!existsSync(join(runDir, "results.tar.gz")));
});

test("local without --results-upload: preserves the results into the run dir, uploads nothing", async () => {
  const { box, runDir } = tempDirs();
  const resultsDir = writeResultsDir(box);
  const receipts: UploadReceipt[] = [];

  const output = await uploadCollectedResults(realContext("local"), resultsDir, runDir, "11111111-2222-4333-8444-555555555555", capturingUpload(receipts));

  assert.equal(receipts.length, 0);
  assert.deepEqual(output.artifacts, []);
  // No tar - just a copy, so the summary table points at where it landed.
  assert.ok(!existsSync(join(runDir, "results.tar")));
  const preservedDir = join(runDir, "results");
  assert.deepEqual(output.details, [{ label: "Preserved results", value: preservedDir }]);
  assert.ok(existsSync(join(preservedDir, "aaaaaaaa", "run.json5")));
  // The driver's own files are untouched too - no AWS call was needed to get here.
  assert.ok(existsSync(join(resultsDir, "aaaaaaaa", "run.json5")));
});

test("remote without --results-upload: collects and keeps the files, uploads nothing", async () => {
  const { box, runDir } = tempDirs();
  const resultsDir = writeResultsDir(box);
  const receipts: UploadReceipt[] = [];

  const output = await uploadCollectedResults(realContext("remote"), resultsDir, runDir, "11111111-2222-4333-8444-555555555555", capturingUpload(receipts));

  assert.equal(receipts.length, 0);
  assert.deepEqual(output.details, [{ label: "Preserved results", value: join(runDir, "results") }]);
  assert.ok(existsSync(join(runDir, "results", "aaaaaaaa", "run.json5")));
  // A cloud instance is no exception: the tar is still collected as an artifact.
  assert.deepEqual(output.artifacts.map((a) => a.filename.endsWith("results.tar")), [true]);
});

/**
 * The AWS preflight exists for the upload, so it has to be gated the same way -
 * a run without --results-upload never uploads and so must not demand credentials.
 */
const SITUATIONAL_GROUP = [{ type: "situational" }] as unknown as Parameters<typeof needsResultsUpload>[0];
const FUNCTIONAL_GROUP = [{ type: "functional", sessions: [{ runs: [{ type: "functional" }] }] }] as unknown as Parameters<typeof needsResultsUpload>[0];
const PERFORMANCE_GROUP = [{ type: "functional", sessions: [{ runs: [{ type: "performance" }] }] }] as unknown as Parameters<typeof needsResultsUpload>[0];

test("without --results-upload no run needs AWS credentials for results", () => {
  assert.equal(needsResultsUpload(SITUATIONAL_GROUP, false), false);
  assert.equal(needsResultsUpload(PERFORMANCE_GROUP, false), false);
});

test("with --results-upload, situational and performance runs need AWS credentials for the upload", () => {
  assert.equal(needsResultsUpload(SITUATIONAL_GROUP, true), true);
  assert.equal(needsResultsUpload(PERFORMANCE_GROUP, true), true);
});

test("a functional run needs no results upload even with --results-upload", () => {
  assert.equal(needsResultsUpload(FUNCTIONAL_GROUP, true), false);
});

const CLOUD_ID = "b0652a58-45d4-4cf7-afff-343ca735c6c6";

test("debug links are added to the collected copy before it is kept", async () => {
  const { box, runDir } = tempDirs();
  const resultsDir = writeResultsDir(box);
  writeFileSync(
    join(resultsDir, "aaaaaaaa", "run.json5"),
    JSON.stringify({ forDatabase: { runUuid: "aaaaaaaa-0000-4000-8000-000000000001", debug: { items: [{ label: "Capella cluster id", description: CLOUD_ID }] } } }),
  );

  await uploadCollectedResults(realContext("local"), resultsDir, runDir, "11111111-2222-4333-8444-555555555555", capturingUpload([]), {
    debugLinks: { ciUrl: "https://github.com/o/r/actions/runs/1" },
  });

  const kept = JSON.parse(readFileSync(join(runDir, "results", "aaaaaaaa", "run.json5"), "utf8")) as { forDatabase: { debug: { items: { label: string }[] } } };
  assert.deepEqual(kept.forDatabase.debug.items.map((i) => i.label), ["Capella cluster id", "CI URL"]);
});

/** A perf run's local results dir with one bundle per uuid given. */
function writePerfResults(uuids: readonly string[]): string {
  const { box } = tempDirs();
  const resultsDir = join(box, "results");
  for (const uuid of uuids) {
    const bundle = join(resultsDir, uuid.slice(0, 8));
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "run.json5"), JSON.stringify({ runUuid: uuid, forDatabase: { workload: { operations: [] } } }));
  }
  return resultsDir;
}

const PERF_RUN = "cccccccc-0000-4000-8000-000000000003";
const STALE_RUN = "dddddddd-0000-4000-8000-000000000004";
const PUBLISHING: ResultsPublishing = { runGroupId: "11111111-2222-4333-8444-555555555555", upload: true, debugLinks: { ciUrl: "https://ci" } };

function perfRun(resultsDir: string, ok: boolean) {
  return { ok, perfResultsDir: resultsDir, assessment: { ok, reasons: [], bundles: [join(resultsDir, PERF_RUN.slice(0, 8))], bucketRows: ok ? 10 : 0 } };
}

test("a performance run uploads only its own bundle, under the invocation's id", async () => {
  const resultsDir = writePerfResults([PERF_RUN, STALE_RUN]);
  const calls: { dir: string; opts: unknown }[] = [];
  await publishPerfResults(perfRun(resultsDir, true), PUBLISHING, (dir, _bucket, opts) => {
    calls.push({ dir, opts });
    return Promise.resolve({ artifacts: [], details: [] });
  });
  assert.deepEqual(calls, [{ dir: resultsDir, opts: { fallbackId: PUBLISHING.runGroupId, onlyDirs: ["cccccccc"] } }]);
  const record = JSON.parse(readFileSync(join(resultsDir, "cccccccc", "run.json5"), "utf8")) as { forDatabase: { debug: { items: { label: string }[] } } };
  assert.deepEqual(record.forDatabase.debug.items.map((i) => i.label), ["CI URL"]);
  // The stale bundle is left exactly as it was.
  assert.equal(readFileSync(join(resultsDir, "dddddddd", "run.json5"), "utf8").includes("debug"), false);
});

test("a performance run with no usable results is never uploaded", async () => {
  const resultsDir = writePerfResults([PERF_RUN]);
  let uploads = 0;
  await publishPerfResults(perfRun(resultsDir, false), PUBLISHING, () => {
    uploads++;
    return Promise.resolve({ artifacts: [], details: [] });
  });
  assert.equal(uploads, 0);
});

test("a performance run without --results-upload keeps its files", async () => {
  const resultsDir = writePerfResults([PERF_RUN]);
  let uploads = 0;
  const output = await publishPerfResults(perfRun(resultsDir, true), { ...PUBLISHING, upload: false }, () => {
    uploads++;
    return Promise.resolve({ artifacts: [], details: [] });
  });
  assert.equal(uploads, 0);
  assert.deepEqual(output.details, [{ label: "Preserved results", value: resultsDir }]);
});

test("a failed perf upload is reported, not thrown — the run already happened", async () => {
  const resultsDir = writePerfResults([PERF_RUN]);
  const output = await publishPerfResults(perfRun(resultsDir, true), PUBLISHING, () => Promise.reject(new Error("S3 says no")));
  assert.deepEqual(output, { artifacts: [], details: [] });
});

test("runsPerfRemotely: only a perf run on a remote instance needs the binary built up front", () => {
  type Override = Parameters<typeof runsPerfRemotely>[1];
  const definition = { kind: "definition" } as Override;
  const localhost = { kind: "localhost" } as Override;
  const aws = { kind: "aws" } as Override;
  const perfOn = (kind: string) =>
    [{ type: "functional", instance: { kind }, sessions: [{ runs: [{ type: "performance" }] }] }] as unknown as Parameters<typeof runsPerfRemotely>[0];
  const functionalOn = (kind: string) =>
    [{ type: "functional", instance: { kind }, sessions: [{ runs: [{ type: "functional" }] }] }] as unknown as Parameters<typeof runsPerfRemotely>[0];

  assert.equal(runsPerfRemotely(perfOn("aws"), definition), true);
  assert.equal(runsPerfRemotely(perfOn("gcp"), definition), true);
  assert.equal(runsPerfRemotely(perfOn("localhost"), definition), false);
  assert.equal(runsPerfRemotely(perfOn("aws"), localhost), false);
  assert.equal(runsPerfRemotely(perfOn("localhost"), aws), true);
  assert.equal(runsPerfRemotely(functionalOn("aws"), definition), false);
});
