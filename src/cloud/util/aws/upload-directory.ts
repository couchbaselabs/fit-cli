/**
 * upload-directory — copy a local directory tree to S3, recursively. Uses
 * PutObject per file (no bucket listing, unlike s3 sync), so a write-only role
 * is enough. Like the rest of this directory it knows nothing about FIT —
 * callers pick the bucket/key.
 *
 * Run on its own:
 *   bun src/cloud/util/aws/upload-directory.ts ./local s3://my-bucket/prefix
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { prepareAwsCli } from "./aws-cli.js";
import { s3Client } from "./aws-clients.js";
import { AWS_REGION } from "./aws-target.js";

function* walkDir(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full);
    } else {
      yield full;
    }
  }
}

function parseS3Uri(uri: string): { bucket: string; prefix: string } {
  const match = uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (!match) {
    throw new Error(`Invalid S3 URI: ${uri}`);
  }
  return { bucket: match[1], prefix: match[2] ?? "" };
}

/** Console URL for browsing a bucket/prefix's objects (not just the raw s3:// URI). */
function s3ConsoleUrl(bucket: string, prefix: string): string {
  const encodedPrefix = encodeURIComponent(prefix ? `${prefix}/` : "");
  return `https://${AWS_REGION}.console.aws.amazon.com/s3/buckets/${bucket}?prefix=${encodedPrefix}&region=${AWS_REGION}`;
}

/**
 * Recursively upload `localDir` to `s3Uri` (e.g. s3://bucket/prefix). Logs
 * each uploaded file. Rejects if any upload fails.
 */
export async function uploadDirectoryToS3(localDir: string, s3Uri: string): Promise<void> {
  const { bucket, prefix } = parseS3Uri(s3Uri);
  const files = [...walkDir(localDir)];
  console.log(`Uploading ${files.length} file(s) to ${s3Uri}...`);
  console.log(`  ${s3ConsoleUrl(bucket, prefix)}`);
  for (const file of files) {
    const relPath = relative(localDir, file).replace(/\\/g, "/");
    const key = prefix ? `${prefix}/${relPath}` : relPath;
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      // bun drops chunks from streamed bodies (oven-sh/bun#39752), so buffer instead
      Body: readFileSync(file),
      ContentLength: statSync(file).size,
    }));
    console.log(`  ${relPath}`);
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const [localDir, s3Uri, ...extra] = process.argv.slice(2);
    if (!localDir || !s3Uri || extra.length > 0) {
      throw new Error("Usage: upload-directory.ts <localDir> <s3://bucket/prefix>");
    }
    await prepareAwsCli();
    await uploadDirectoryToS3(localDir, s3Uri);
    console.log(`✓ Uploaded ${localDir} to ${s3Uri}`);
  });
}
