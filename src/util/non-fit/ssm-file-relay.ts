/**
 * ssm-file-relay — putFile/getFile for SsmTarget. SSM has no scp equivalent, so
 * a transfer goes local <-> S3 <-> (presigned URL) <-> curl on the instance.
 * Reuses the existing S3 upload/download helpers (archive.ts) and bucket
 * (upload-run-artifacts.ts) fit-cli already has for run-artifact uploads,
 * rather than standing up a separate bucket/convention.
 *
 * Only `curl` runs on the remote box (already present on Ubuntu) — no AWS
 * CLI/SDK there, keeping the "SDK only" constraint scoped to fit-cli's own
 * process.
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client } from "../../cloud/util/aws/aws-clients.js";
import { downloadFileFromS3, uploadFileToS3 } from "../../fit/archive/archive.js";
import { ARTIFACTS_BUCKET } from "../../fit/util/aws/upload-run-artifacts.js";
import { formatBytes } from "./fit-cli-log.js";
import { posixQuote } from "./remote-target.js";
import type { ExecutionTarget } from "./target.js";

const RELAY_PREFIX = "ssm-relay";
const PRESIGN_EXPIRY_SECONDS = 900;

/** Anything that can run a shell command on the instance and knows its own id. */
export type RelayTarget = Pick<ExecutionTarget, "run" | "description"> & { readonly instanceId: string };

function scratchKey(instanceId: string, filename: string): string {
  return `${RELAY_PREFIX}/${instanceId}/${randomUUID()}-${filename}`;
}

async function deleteScratchObject(key: string): Promise<void> {
  // Best-effort: a bucket lifecycle rule on the ssm-relay/ prefix is the real
  // safety net (see the migration plan) — this is just tidiness.
  await s3Client.send(new DeleteObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: key })).catch(() => {});
}

/** Copy a local file up to `remotePath` on `target`, via a scratch S3 object + presigned URL. */
export async function ssmPutFile(target: RelayTarget, localPath: string, remotePath: string): Promise<void> {
  const key = scratchKey(target.instanceId, basename(localPath));
  await uploadFileToS3(localPath, `s3://${ARTIFACTS_BUCKET}/${key}`);
  try {
    const url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: key }), { expiresIn: PRESIGN_EXPIRY_SECONDS });
    await target.run("sh", ["-c", `curl -fsSL -o ${posixQuote(remotePath)} ${posixQuote(url)}`], undefined, {
      display: `put ${localPath} -> ${target.description}:${remotePath}`,
    });
  } finally {
    await deleteScratchObject(key);
  }
}

/** Copy `remotePath` on `target` down to a local file, via a presigned URL + scratch S3 object. */
export async function ssmGetFile(target: RelayTarget, remotePath: string, localPath: string, sizeBytes?: number): Promise<void> {
  const key = scratchKey(target.instanceId, basename(remotePath));
  const url = await getSignedUrl(s3Client, new PutObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: key }), { expiresIn: PRESIGN_EXPIRY_SECONDS });
  const size = sizeBytes !== undefined ? ` (${formatBytes(sizeBytes)})` : "";
  try {
    await target.run("sh", ["-c", `curl -fsSL -T ${posixQuote(remotePath)} ${posixQuote(url)}`], undefined, {
      display: `get ${target.description}:${remotePath}${size} -> ${localPath}`,
    });
    await downloadFileFromS3(`s3://${ARTIFACTS_BUCKET}/${key}`, localPath);
  } finally {
    await deleteScratchObject(key);
  }
}
