/**
 * upload-results: upload a FIT/SIT run's results directories to S3, where the
 * ingest job on the results database server picks them up. The test-driver
 * writes one directory per run (transactions-fit-performer I3f285a9e); each
 * complete one goes to s3://fit-cli/incoming/<situationalRunUuid>/<runUuid>/,
 * followed by the DONE_MARKER object that makes the run visible to the ingest.
 *
 * Run on its own:
 *   bun src/fit/situational/upload-results/upload-results.ts <resultsDir>
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import JSON5 from "json5";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type Detail, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { s3Client } from "../../../cloud/util/aws/aws-clients.js";
import { uploadDirectoryToS3 } from "../../../cloud/util/aws/upload-directory.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where results go by default: the same bucket the run-artifacts zips live in
 * (see ARTIFACTS_BUCKET), under the incoming/ prefix the ingest job reads.
 */
export const RESULTS_BUCKET = "fit-cli";

/**
 * Empty object written as the very last step of a run's upload. The ingest only
 * takes a run directory that has it, so it never reads a half-uploaded run.
 * Shared with the ingest side so the two ends cannot drift.
 */
export const DONE_MARKER = ".done";

/** One run directory found under the results output directory. */
export interface ResultsRunDir {
  /** Basename of the run's directory (the first 8 chars of its run uuid). */
  dirName: string;
  /** Contents of the directory's run.json5, when it has one. */
  runJson5?: string;
}

export interface PlannedUpload {
  dirName: string;
  runUuid: string;
  /** Key prefix under the bucket (no trailing slash). */
  keyPrefix: string;
}

export interface UploadPlan {
  /** The situational run every upload in this plan belongs to. */
  situationalRunUuid: string;
  uploads: PlannedUpload[];
  /** "dirName: reason" per run dir that can't be uploaded. A skipped dir never fails the upload (the runs themselves already happened). */
  skipped: string[];
}

/**
 * Decide what gets uploaded where. Pure (maps the directory listing to key
 * prefixes) so it's easy to unit test.
 *
 * A dir without a parseable run.json5 is skipped (the run died before
 * finalizeRun wrote it), as is one whose run.json5 uuid doesn't match the dir
 * name since uploading it would store the data under the wrong run.
 */
export function planResultsUpload(
  runDirs: readonly ResultsRunDir[],
  situationalRunId?: string,
  newSituationalRunId: () => string = randomUUID,
): UploadPlan {
  const uploads: PlannedUpload[] = [];
  const skipped: string[] = [];
  // Lowercased because S3 keys are case-sensitive
  const situationalRunUuid = situationalRunId?.toLowerCase() ?? newSituationalRunId();

  for (const dir of [...runDirs].sort((a, b) => a.dirName.localeCompare(b.dirName))) {
    if (dir.runJson5 === undefined) {
      skipped.push(`${dir.dirName}: no run.json5 (the run was never finalized)`);
      continue;
    }
    let forDatabase: { runUuid?: string };
    try {
      const parsed = JSON5.parse<{ forDatabase?: typeof forDatabase }>(dir.runJson5);
      forDatabase = parsed.forDatabase ?? {};
    } catch (err) {
      skipped.push(`${dir.dirName}: run.json5 is unparseable (${(err as Error).message})`);
      continue;
    }
    // `?.` alone would still crash on a non-string runUuid (e.g. numeric); a bad
    // run.json5 must skip this one dir, not fail the whole plan.
    const runUuid = typeof forDatabase.runUuid === "string" ? forDatabase.runUuid.toLowerCase() : undefined;
    if (!runUuid || !UUID_RE.test(runUuid)) {
      skipped.push(`${dir.dirName}: run.json5 has no valid forDatabase.runUuid`);
      continue;
    }
    if (!runUuid.startsWith(dir.dirName.toLowerCase())) {
      skipped.push(`${dir.dirName}: run.json5 is for run ${runUuid}, not this directory`);
      continue;
    }

    uploads.push({
      dirName: dir.dirName,
      runUuid,
      keyPrefix: `incoming/${situationalRunUuid}/${runUuid}`,
    });
  }
  return { situationalRunUuid, uploads, skipped };
}

function readResultsDir(resultsDir: string): ResultsRunDir[] {
  if (!existsSync(resultsDir)) {
    throw new Error(`Results directory not found: ${resultsDir}`);
  }
  return readdirSync(resultsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const runJson5Path = join(resultsDir, entry.name, "run.json5");
      return {
        dirName: entry.name,
        ...(existsSync(runJson5Path) ? { runJson5: readFileSync(runJson5Path, "utf8") } : {}),
      };
    });
}

/** Publishes the run to the ingest. Must be the last write of the directory. */
async function writeDoneMarker(bucket: string, keyPrefix: string): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({ Bucket: bucket, Key: `${keyPrefix}/${DONE_MARKER}`, Body: "", ContentLength: 0 }),
  );
}

/**
 * Upload every complete run directory under `resultsDir` to the results bucket,
 * via {@link uploadDirectoryToS3} with the ambient AWS credentials.
 */
export async function uploadSituationalResults(
  resultsDir: string,
  bucket: string = RESULTS_BUCKET,
  situationalRunId?: string,
): Promise<RunOutput> {
  const plan = planResultsUpload(readResultsDir(resultsDir), situationalRunId);
  for (const skip of plan.skipped) {
    console.warn(`Skipping ${skip}`);
  }
  if (plan.uploads.length === 0) {
    console.log(`Nothing to upload from ${resultsDir}`);
  }

  const details: Detail[] = [];
  for (const upload of plan.uploads) {
    const destination = `s3://${bucket}/${upload.keyPrefix}`;
    console.log(`Uploading run ${upload.runUuid} to ${destination}/`);
    await uploadDirectoryToS3(join(resultsDir, upload.dirName), destination);
    await writeDoneMarker(bucket, upload.keyPrefix);
    console.log(`  ${DONE_MARKER} (the run is now visible to the ingest)`);
    details.push({ label: `Run ${upload.dirName}`, value: `${destination}/` });
  }
  return { artifacts: [], details };
}

const USAGE = `Upload FIT/SIT results directories to the results S3 bucket.

Usage: bun src/fit/situational/upload-results/upload-results.ts <resultsDir> [options]

Options:
  --bucket <name>              Upload to this bucket instead of ${RESULTS_BUCKET}.
  --situational-run-id <uuid>  Group all runs under this situational run id.
  --help, -h                   Show this help.

<resultsDir> is the files output directory a FIT/SIT test-driver run wrote
(one subdirectory per run, named by the first 8 chars of the run uuid).`;

function parseArgs(argv: string[]): { resultsDir: string; bucket: string; situationalRunId?: string } {
  const args = argv.filter((a) => a !== "--");
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    if (at === -1) return undefined;
    const value = args[at + 1];
    if (value === undefined) throw new Error(`${name} needs a value`);
    args.splice(at, 2);
    return value;
  };
  const bucket = flag("--bucket") ?? RESULTS_BUCKET;
  const situationalRunId = flag("--situational-run-id");
  if (situationalRunId && !UUID_RE.test(situationalRunId)) throw new Error("--situational-run-id must be a UUID");
  if (args.length !== 1) throw new Error(`Expected exactly one results directory, got: ${args.join(" ") || "(none)"}`);
  return { resultsDir: args[0], bucket, ...(situationalRunId ? { situationalRunId } : {}) };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const parsed = parseArgs(process.argv.slice(2));
    return await uploadSituationalResults(parsed.resultsDir, parsed.bucket, parsed.situationalRunId);
  });
}
