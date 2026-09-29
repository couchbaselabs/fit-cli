/**
 * One manifest per CI run (run id + attempt): whether its records exist and, if not, why.
 * Backfill asks only "is there a manifest?", whatever its status, so a failed parse is a
 * recorded result and is not retried every time - only when the parser version changes.
 */

import type { CiContext } from "./run-record.js";

export const MANIFEST_SCHEMA = 1 as const;

/**
 * ok               parsed; `records` lists what was written
 * parse_error      no parser recognised the log, or a sanity check failed; see `reason`
 * unsupported_era  a known-unreadable period (e.g. situational before 2026-07-11)
 * fetch_pending    fetching the log failed for a temporary reason; retried up to a limit
 * fetch_failed     gave up after too many fetch attempts
 * expired          GitHub has already deleted the log
 */
export type ManifestStatus = "ok" | "parse_error" | "unsupported_era" | "fetch_pending" | "fetch_failed" | "expired";

export interface RunManifest {
  schema: typeof MANIFEST_SCHEMA;
  sdk: string;
  runId: number;
  runAttempt: number;
  date: string;
  /** The run's CI context, so a reparse can rebuild records without GitHub. */
  ci?: CiContext;
  status: ManifestStatus;
  parserVersion?: string;
  reason?: string;
  fetchAttempts?: number;
  /** Record keys written for this run, relative to the store root. */
  records: string[];
  /** Per-record problems that did not fail the whole run (e.g. one preset's sanity check). */
  warnings?: string[];
  /** Whether the run's records were upgraded from the JUnit in its S3 archive; see archive-junit.ts. */
  archive?: ArchiveUpgrade;
}

/**
 * ok       every record with results was upgraded
 * partial  some were; `skipped` says why the rest weren't
 * none     the log names no archive, or it has expired (S3 keeps runs/ for 180 days)
 * error    reading the archive failed; retried up to MAX_FETCH_ATTEMPTS
 */
export interface ArchiveUpgrade {
  status: "ok" | "partial" | "none" | "error";
  upgraded: string[];
  skipped: string[];
  reason?: string;
  attempts: number;
}

export const MAX_FETCH_ATTEMPTS = 5;

export function manifestKey(sdk: string, runId: number, runAttempt: number): string {
  return `${sdk}/manifests/${runId}-${runAttempt}.json`;
}

export function rawLogKey(sdk: string, runId: number, runAttempt: number): string {
  return `${sdk}/raw/${runId}-${runAttempt}.log.gz`;
}

/** Should backfill try (again) to upgrade this run's records from its archive? */
export function needsArchiveUpgrade(manifest: RunManifest): boolean {
  if (manifest.status !== "ok") return false;
  if (!manifest.archive) return true;
  return manifest.archive.status === "error" && manifest.archive.attempts < MAX_FETCH_ATTEMPTS;
}

/**
 * Should backfill (re)process this run? Nothing exists yet; a fetch that may yet succeed;
 * or a parse error from an older parser. Everything else is final.
 */
export function needsWork(manifest: RunManifest | undefined, currentParserVersion: string): boolean {
  if (!manifest) return true;
  switch (manifest.status) {
    case "fetch_pending":
      return (manifest.fetchAttempts ?? 0) < MAX_FETCH_ATTEMPTS;
    case "parse_error":
      return manifest.parserVersion !== currentParserVersion;
    default:
      return false;
  }
}
