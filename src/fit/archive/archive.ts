#!/usr/bin/env node
/**
 * fit archive — zip a run artifact directory and/or upload it to S3.
 *
 *   fit archive zip <dir>
 *   fit archive s3-upload [--zip] <dir> [<s3-uri>]
 *   fit archive fetch <s3-zip-uri> [<output-dir>]
 *
 * zip:        Creates <dir>.zip next to the source directory.
 * s3-upload:  Uploads the directory to S3, either as individual files (default)
 *             or as a single zip archive (--zip). <s3-uri> defaults to
 *             s3://fit-cli/runs/.
 * fetch:      Downloads a .zip from S3 and extracts it locally. Output dir
 *             defaults to /tmp/fetched/<name-without-.zip>.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { ZipArchive } from "archiver";
import { Upload } from "@aws-sdk/lib-storage";
import { s3Client } from "../../cloud/util/aws/aws-clients.js";
import { checkAwsCredentials } from "../../cloud/util/aws/identity.js";
import { isTransientAwsFailure } from "../../cloud/util/aws/transient-failure.js";
import { uploadDirectoryToS3 } from "../../cloud/util/aws/upload-directory.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { fitCliWarn, runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { run } from "../../util/non-fit/proc.js";
import { retryWhole } from "../../util/non-fit/retry.js";
import { SITUATIONAL_RESULTS_DIR_NAME } from "../situational/configuration/build-situational-configuration.js";
import { ARTIFACTS_BUCKET, ARTIFACTS_PREFIX } from "../util/aws/upload-run-artifacts.js";

/**
 * uploadCollectedResults (run-from-definition.ts) deletes the extracted results/
 * directory after a remote run uploads it, keeping only results.tar in the
 * archive to avoid duplicating every result file in it. Re-extract those tars
 * here instead, so a locally fetched archive is as easy to read as a local run's.
 */
function findResultsTars(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findResultsTars(full));
    } else if (entry.name === "results.tar") {
      found.push(full);
    }
  }
  return found;
}

function helpText(): string {
  const p = runScriptPrefix("archive");
  return `Archive (zip / S3-upload / fetch) a fit-cli run artifact directory.

Usage:
  ${p} zip <dir>
  ${p} s3-upload [--zip] <dir> [<s3-uri>]
  ${p} fetch <s3-zip-uri> [<output-dir>]
  ${p} --help

Subcommands:
  zip         Create <dir>.zip next to the source directory.
  s3-upload   Upload <dir> to S3. Without --zip, uploads each file individually;
              with --zip, zips first and uploads the single archive.
              <s3-uri> defaults to s3://${ARTIFACTS_BUCKET}/${ARTIFACTS_PREFIX}/.
  fetch       Download a .zip from S3 and extract it locally.
              <output-dir> defaults to /tmp/fetched/<name-without-.zip>.`;
}

/**
 * Glob patterns for run-dir content that must never leave the machine — secrets
 * that fit-cli keeps in `_internal` (SSH private keys, driver env files). Excluded
 * from the S3 zip here; the GitHub Actions upload-artifact step mirrors this with
 * its own `!.../_internal/**` path exclusion (it can't import this constant).
 */
export const ARTIFACT_UPLOAD_EXCLUDE_GLOBS = ["**/_internal/**"];

/** Zip the contents of sourceDir into a new file at outputPath, excluding secrets. */
export async function zipDirectory(sourceDir: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    // glob (rather than directory()) so we can exclude `_internal` — archiver's
    // directory() has no ignore option. dot:true keeps dotfiles that directory() included.
    archive.glob("**/*", { cwd: sourceDir, ignore: ARTIFACT_UPLOAD_EXCLUDE_GLOBS, dot: true });
    void archive.finalize();
  });
}

/**
 * Multipart part size. The SDK default of 5 MB means ~300 uploads for a 1.5 GB
 * situational run zip; 16 MB cuts that by three, so there are far fewer requests
 * to lose a socket on. queueSize stays at its default of 4, so at most 64 MB is
 * buffered in memory at once.
 */
const UPLOAD_PART_SIZE = 16 * 1024 * 1024;

/**
 * Concurrent part uploads on the first attempt (the SDK's own default, stated here
 * because a retry deliberately differs from it — see uploadFileToS3).
 */
const UPLOAD_QUEUE_SIZE = 4;

/**
 * Backoff between whole-upload attempts, so three attempts at most. Longer than a
 * blink on purpose: the one failure we have data for killed two attempts a minute
 * apart, so a 5-second wait would have hit exactly the same weather.
 */
const UPLOAD_RETRY_DELAYS_MS = [10_000, 30_000];

/**
 * Ceiling on the whole upload including its retries. Expressed as a budget rather
 * than an attempt count so it scales itself: a 90 MB archive uploads in seconds and
 * gets every attempt, a 1.5 GB one takes ~a minute an attempt and gets fewer.
 */
const UPLOAD_BUDGET_MS = 5 * 60_000;

/**
 * Upload a single local file to an S3 URI (s3://bucket/key).
 *
 * `Upload` uses multipart under the hood and retries an individual part, avoiding
 * the non-retryable streaming timeout that PutObjectCommand hits. What it can't
 * survive is a socket dropped mid-transfer, which surfaces as "The socket
 * connection was closed unexpectedly" and takes the whole transfer with it (seen
 * on 1.4 GB run zips on GHA). Recovering means starting over with a fresh read
 * stream, since a consumed one can't be replayed — hence the retry wrapping the
 * whole `Upload` rather than living inside it.
 *
 * A retry is also a different attempt, not a repeat: by the time we get here the
 * SDK has already retried the failing part and lost, so the second attempt sends
 * one part at a time. If the cause is client-side connection handling, that's the
 * thing most likely to get through; if it isn't, the logs say so.
 *
 * `onProgress` is reported per attempt, so a retry restarts it at zero — which is
 * what's actually happening, the bytes from the dead attempt having gone nowhere.
 *
 * `client` defaults to the shared S3 client and exists to be pointed elsewhere —
 * at a local endpoint that drops connections on purpose — when verifying that a
 * retry really does re-read the file from the start.
 */
export async function uploadFileToS3(
  localPath: string,
  s3Uri: string,
  onProgress?: (transferred: number, total: number | undefined) => void,
  client: S3Client = s3Client,
): Promise<void> {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid S3 URI for a single file (must include a key): ${s3Uri}`);
  }
  const [, bucket, key] = match;
  const total = statSync(localPath).size;
  await retryWhole(
    // The read stream is opened inside the attempt, not outside it: an attempt that
    // fails part-way has consumed some of it, so a retry needs its own.
    async (attempt) => {
      const upload = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: key,
          Body: createReadStream(localPath),
        },
        partSize: UPLOAD_PART_SIZE,
        queueSize: attempt === 1 ? UPLOAD_QUEUE_SIZE : 1,
      });
      upload.on("httpUploadProgress", (progress) => {
        onProgress?.(progress.loaded ?? 0, progress.total ?? total);
      });
      await upload.done();
    },
    {
      delaysMs: UPLOAD_RETRY_DELAYS_MS,
      totalBudgetMs: UPLOAD_BUDGET_MS,
      shouldRetry: isTransientAwsFailure,
      onRetry: (err, waitMs, nextAttempt) =>
        fitCliWarn(
          `Upload of ${basename(localPath)} failed (${err.message}), retrying from the start in ` +
            `${waitMs / 1000}s (attempt ${nextAttempt} of ${UPLOAD_RETRY_DELAYS_MS.length + 1}, one part at a time)...`,
        ),
    },
  );
}

/**
 * Returns a renderer for a live, overwrite-in-place progress bar plus a
 * matching clear function. Shared by cmdFetch (download) and cmdS3Upload
 * (upload) so both S3 transfers get the same terminal feedback.
 */
function createProgressRenderer(): {
  render: (transferred: number, total: number | undefined) => void;
  clear: () => void;
} {
  const MB = 1024 * 1024;
  let lineLen = 0;
  return {
    render(transferred, total) {
      const doneMB = (transferred / MB).toFixed(1);
      let line: string;
      if (total) {
        const pct = transferred / total;
        const width = 30;
        const filled = Math.round(pct * width);
        const bar = "█".repeat(filled) + "░".repeat(width - filled);
        const totalMB = (total / MB).toFixed(1);
        line = `  [${bar}] ${doneMB} / ${totalMB} MB (${Math.round(pct * 100)}%)`;
      } else {
        line = `  ${doneMB} MB transferred`;
      }
      process.stderr.write(`\r${line.padEnd(lineLen)}`);
      lineLen = line.length;
    },
    clear() {
      process.stderr.write(`\r${" ".repeat(lineLen)}\r`);
    },
  };
}

async function cmdZip(argv: string[]): Promise<void> {
  const [dir, ...extra] = argv;
  if (!dir || extra.length > 0) {
    console.error(`Usage: ${runScriptPrefix("archive")} zip <dir>`);
    process.exit(2);
  }
  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    console.error(`Directory not found: ${absDir}`);
    process.exit(1);
  }
  const outputPath = `${absDir}.zip`;
  console.log(`Zipping ${absDir} → ${outputPath} ...`);
  await zipDirectory(absDir, outputPath);
  console.log(`✓ Created ${outputPath}`);
}

async function cmdS3Upload(argv: string[]): Promise<void> {
  const creds = await checkAwsCredentials();
  if (!creds.ok) {
    throw new Error(`AWS credentials are not usable: ${creds.message}`);
  }

  const args = [...argv];
  const zipIdx = args.indexOf("--zip");
  const doZip = zipIdx !== -1;
  if (doZip) args.splice(zipIdx, 1);

  const [dir, s3UriArg, ...extra] = args;
  if (!dir || extra.length > 0) {
    console.error(`Usage: ${runScriptPrefix("archive")} s3-upload [--zip] <dir> [<s3-uri>]`);
    process.exit(2);
  }
  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    console.error(`Directory not found: ${absDir}`);
    process.exit(1);
  }
  const dirName = basename(absDir);
  const destination = s3UriArg ?? `s3://${ARTIFACTS_BUCKET}/${ARTIFACTS_PREFIX}/${dirName}/`;

  if (doZip) {
    const zipPath = `${absDir}.zip`;
    console.log(`Zipping ${absDir} → ${zipPath} ...`);
    await zipDirectory(absDir, zipPath);
    console.log(`✓ Created ${zipPath}`);
    const zipKey = destination.endsWith("/") ? `${destination}${dirName}.zip` : destination;
    console.log(`Uploading ${zipPath} → ${zipKey} ...`);
    const progress = createProgressRenderer();
    await uploadFileToS3(zipPath, zipKey, progress.render);
    progress.clear();
    console.log(`✓ Uploaded to ${zipKey}`);
    console.log(`  Download:   ${runScriptPrefix("archive")} fetch ${zipKey}`);
    console.log(`  Or direct:  aws s3 cp ${zipKey} .`);
  } else {
    console.log(`Uploading ${absDir} → ${destination} ...`);
    await uploadDirectoryToS3(absDir, destination);
    console.log(`✓ Uploaded to ${destination}`);
    console.log(`  Download:  aws s3 cp --recursive ${destination} ${dirName}/`);
  }
}

/** Download a single S3 URI (s3://bucket/key) to a local file path. */
export async function downloadFileFromS3(
  s3Uri: string,
  localPath: string,
  onProgress?: (downloaded: number, total: number | undefined) => void,
): Promise<void> {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid S3 URI: ${s3Uri}`);
  const [, bucket, key] = match;
  mkdirSync(dirname(localPath), { recursive: true });
  const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!resp.Body) throw new Error(`Empty response body for ${s3Uri}`);
  const total = resp.ContentLength;
  let downloaded = 0;
  onProgress?.(0, total);
  const tracker = new Transform({
    transform(chunk: Buffer, _, callback) {
      downloaded += chunk.length;
      onProgress?.(downloaded, total);
      callback(null, chunk);
    },
  });
  await pipeline(resp.Body as NodeJS.ReadableStream, tracker, createWriteStream(localPath));
}

async function cmdFetch(argv: string[]): Promise<void> {
  const creds = await checkAwsCredentials();
  if (!creds.ok) {
    throw new Error(`AWS credentials are not usable: ${creds.message}`);
  }

  const [s3Uri, outputDirArg, ...extra] = argv;
  if (!s3Uri || extra.length > 0) {
    console.error(`Usage: ${runScriptPrefix("archive")} fetch <s3-zip-uri> [<output-dir>]`);
    process.exit(2);
  }
  if (!s3Uri.endsWith(".zip")) {
    console.error(`Expected a .zip S3 URI, got: ${s3Uri}`);
    process.exit(1);
  }
  const zipName = basename(s3Uri);
  const runName = zipName.replace(/\.zip$/, "");
  const outputDir = outputDirArg ?? `/tmp/fetched/${runName}`;
  const zipPath = `${outputDir}.zip`;

  console.log(`Downloading ${s3Uri} → ${zipPath} ...`);
  const progress = createProgressRenderer();
  await downloadFileFromS3(s3Uri, zipPath, progress.render);
  progress.clear();
  console.log(`✓ Downloaded to ${zipPath}`);

  mkdirSync(outputDir, { recursive: true });
  console.log(`Extracting ${zipPath} → ${outputDir} ...`);
  await run("unzip", ["-o", zipPath, "-d", outputDir]);
  console.log(`✓ Extracted to ${outputDir}`);

  const resultsTars = findResultsTars(outputDir);
  for (const tarPath of resultsTars) {
    const destDir = join(dirname(tarPath), SITUATIONAL_RESULTS_DIR_NAME);
    mkdirSync(destDir, { recursive: true });
    await run("tar", ["-xf", tarPath, "-C", destDir]);
  }
  if (resultsTars.length > 0) {
    console.log(`✓ Extracted ${resultsTars.length} results.tar archive(s) into ${SITUATIONAL_RESULTS_DIR_NAME}/`);
  }
}

export function runArchiveMain(): void {
  const [subcommand, ...rest] = process.argv.slice(2);

  runCli(async () => {
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      console.log(helpText());
      if (!subcommand) process.exit(2);
      return;
    }

    if (subcommand === "zip") {
      await cmdZip(rest);
      return;
    }

    if (subcommand === "s3-upload") {
      await cmdS3Upload(rest);
      return;
    }

    if (subcommand === "fetch") {
      await cmdFetch(rest);
      return;
    }

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(helpText());
    process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runArchiveMain();
}
