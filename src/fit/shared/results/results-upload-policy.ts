/**
 * Whether a run's result files (FIT/SIT and FIT/PERF alike) get published to the results
 * S3 bucket, or kept on disk. One rule for both, so they can't drift.
 *
 * Opt-in: they are uploaded only when `fit run` is given `--results-upload`, wherever the run
 * executes. CI passes it (see .github/workflows/fit-cli.yaml); anything else keeps its files,
 * so a development run never lands datapoints in the shared results database by accident.
 */

export const RESULTS_UPLOAD_FLAG = "--results-upload";

/** Why this run's results won't be uploaded, or undefined if they will be. */
export function resultsUploadSkipReason(upload: boolean): string | undefined {
  return upload ? undefined : `${RESULTS_UPLOAD_FLAG} was not given`;
}
