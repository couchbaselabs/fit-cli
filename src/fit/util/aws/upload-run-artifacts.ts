/**
 * upload-run-artifacts — at the end of a run, zip the run's artifact directory
 * and upload it to S3. This lets results outlive the local box or the (ephemeral)
 * GitHub Actions runner, and keeps the GitHub job summary small (link to S3 rather
 * than inlining megabytes of JUnit output, which blows the 1024k step-summary cap).
 *
 * Best-effort: a skipped or failed upload never fails the run. It runs only
 * inside GitHub Actions — where the runner is ephemeral and AWS creds are present
 * via OIDC — so local runs don't surprise-upload to the shared bucket; no GHA
 * config is needed to switch it on. The destination bucket and prefix are fixed,
 * mirroring the fixed AWS region — the bucket lives in us-west-2 (see AWS_REGION).
 *
 * Must be triggered at most once per run: it builds and ships an often
 * gigabyte-scale zip, so a second caller silently doubles both the egress and the
 * wall clock — which is exactly what used to happen. That single trigger is
 * currently renderRunSummary in cli.ts, which runs after teardown on both the
 * success and the failure path and turns the returned URI into the GHA notice and
 * fetch hint.
 */
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fitCliInfo, fitCliWarn, runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { zipDirectory, uploadFileToS3 } from "../../archive/archive.js";

/** Bucket run artifacts are uploaded to (us-west-2, see AWS_REGION). */
export const ARTIFACTS_BUCKET = "fit-cli";
/** Key prefix under the bucket; each run lands as `<prefix>/<runId>.zip`. */
export const ARTIFACTS_PREFIX = "runs";

/** Upload runs only inside GitHub Actions, which always sets GITHUB_ACTIONS=true. */
export function artifactUploadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITHUB_ACTIONS === "true";
}

/**
 * Where {@link maybeUploadRunArtifacts} puts `runDir`'s zip. Known before the zip exists,
 * so a run's result files can link to its archive while the run is still going.
 */
export function runArtifactsZipKey(runDir: string): string {
  return `s3://${ARTIFACTS_BUCKET}/${ARTIFACTS_PREFIX}/${basename(runDir)}.zip`;
}

/**
 * Zip `runDir` and upload it to s3://fit-cli/runs/<dirName>.zip. Returns the
 * destination URI on success, or null when skipped (disabled / dir missing) or
 * failed — it never throws, so it's safe to call from a teardown/finally path.
 */
export async function maybeUploadRunArtifacts(runDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!artifactUploadEnabled(env)) {
    return null;
  }
  if (!existsSync(runDir)) {
    return null;
  }
  const s3Base = `s3://${ARTIFACTS_BUCKET}/${ARTIFACTS_PREFIX}/`;
  const zipPath = `${runDir}.zip`;
  const zipKey = runArtifactsZipKey(runDir);
  try {
    fitCliInfo(`${runScriptPrefix("archive")} s3-upload --zip ${runDir} ${s3Base}`);
    await zipDirectory(runDir, zipPath);
    const zipSizeMb = (statSync(zipPath).size / (1024 * 1024)).toFixed(1);
    fitCliInfo(`Uploading run artifacts (${zipSizeMb} MB) → ${zipKey}`);
    await uploadFileToS3(zipPath, zipKey);
    fitCliInfo(`✓ Uploaded run artifacts to ${zipKey}`);
    fitCliInfo(`  Can fetch later with:     fit archive fetch ${zipKey}`);
    return zipKey;
  } catch (err) {
    fitCliWarn(`Could not upload run artifacts to ${s3Base}: ${(err as Error).message}`);
    return null;
  }
}
