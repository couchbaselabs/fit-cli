#!/usr/bin/env node
/**
 * Fill in run records for an opted-in SDK's nightly runs that GitHub still holds.
 *
 *   bun src/fit/health/backfill/backfill.ts <sdk> [--limit N] [--store <dir>] [--dry-run]
 *
 * For every nightly run with no manifest (or one worth retrying - see needsWork), fetch
 * the whole-run log (every job's, see fetch-run-log.ts), keep it, parse it, and write its
 * records.
 * Safe to rerun: a run that already has a manifest is skipped, so a rerun does only the
 * missing work. Newest first, so an interrupted backfill loses the fewest nights to
 * GitHub's 90-day log retention.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliInfo, fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import { LOG_PARSER_VERSION } from "../log-parse/parse-run-log.js";
import { needsArchiveUpgrade, needsWork } from "../record/run-manifest.js";
import { healthOptIn } from "../registry/health-opt-ins.js";
import { type LocalHealthStore, defaultHealthStoreRoot } from "../store/health-store.js";
import { openStore } from "../store/s3-store.js";
import { fetchRunLog } from "./fetch-run-log.js";
import { ingestLog, recordFetchFailure } from "./ingest-log.js";
import { listNightlyRuns, type CiRun } from "./list-runs.js";
import { upgradeFromArchive } from "./upgrade-from-archive.js";
import { checkStore, renderChecks } from "./checks.js";
import { printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { STORE_OPTION, parseSdkCommandArgs } from "../cli-args.js";

/** A fetch error that means GitHub no longer has the log, so retrying is pointless. */
export function isExpiredLogError(message: string): boolean {
  return /\b(410|gone|expired)\b|log (?:not found|is not available)|could not find any logs/i.test(message);
}

export interface BackfillOptions {
  store: LocalHealthStore;
  limit?: number;
  dryRun?: boolean;
  /** Skip reading JUnit from the runs' S3 archives (e.g. without AWS credentials). */
  skipArchives?: boolean;
}

export interface BackfillSummary {
  alreadyDone: number;
  ingested: number;
  parseErrors: number;
  fetchFailures: number;
  records: number;
  /** Records upgraded to full JUnit from the runs' S3 archives. */
  archiveUpgraded: number;
  archiveRuns: number;
  pending: CiRun[];
}

export async function backfill(sdk: string, opts: BackfillOptions): Promise<BackfillSummary> {
  const optIn = healthOptIn(sdk);
  if (!optIn) throw new Error(`${sdk} has not opted in to fit health - add it to src/fit/health/registry/health-opt-ins.ts`);
  const { runs, warnings } = await listNightlyRuns(optIn);
  for (const w of warnings) fitCliWarn(w);

  const todo = runs.filter((r) => needsWork(opts.store.readManifest(sdk, r.runId, r.runAttempt), LOG_PARSER_VERSION));
  const batch = opts.limit ? todo.slice(0, opts.limit) : todo;
  const summary: BackfillSummary = {
    alreadyDone: runs.length - todo.length,
    ingested: 0,
    parseErrors: 0,
    fetchFailures: 0,
    records: 0,
    archiveUpgraded: 0,
    archiveRuns: 0,
    pending: batch,
  };
  fitCliInfo(`${runs.length} nightly runs on GitHub; ${summary.alreadyDone} already stored; ${todo.length} to fetch${batch.length < todo.length ? ` (this pass: ${batch.length})` : ""}.`);
  if (opts.dryRun) return summary;

  const scratch = join(ensureRunDir(), "fetched-log.txt");
  for (const [i, run] of batch.entries()) {
    const meta = {
      sdk,
      date: run.date,
      ci: { repo: optIn.repo, workflow: run.workflow, ref: `refs/heads/${run.branch}`, sha: run.sha, event: run.event, runId: run.runId, runAttempt: run.runAttempt },
    };
    fitCliInfo(`[${i + 1}/${batch.length}] ${run.date} run ${run.runId} (attempt ${run.runAttempt})`);
    let log: string;
    try {
      log = await fetchRunLog(optIn.repo, run.runId, run.runAttempt, scratch);
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      const expired = isExpiredLogError(message);
      recordFetchFailure(opts.store, meta, expired, message);
      summary.fetchFailures++;
      fitCliWarn(`  could not fetch the log${expired ? " (GitHub has deleted it)" : ""}: ${message.slice(0, 200)}`);
      continue;
    }
    const manifest = ingestLog(opts.store, meta, log);
    summary.ingested++;
    summary.records += manifest.records.length;
    if (manifest.status === "parse_error") {
      summary.parseErrors++;
      fitCliWarn(`  parse error (kept; retried only when the parser changes): ${manifest.reason}`);
    } else {
      fitCliInfo(`  ${manifest.records.length} records${manifest.warnings?.length ? `, ${manifest.warnings.length} warnings` : ""}`);
    }
  }
  rmSync(scratch, { force: true });

  if (!opts.skipArchives) await upgradeAll(sdk, opts, summary);
  return summary;
}

/**
 * Second pass: upgrade scraped records to full JUnit from each run's S3 archive. Separate
 * from the log pass so a run whose log was stored earlier (or imported) is upgraded too.
 */
async function upgradeAll(sdk: string, opts: BackfillOptions, summary: BackfillSummary): Promise<void> {
  const manifests = opts.store
    .listManifests(sdk)
    .filter(needsArchiveUpgrade)
    .sort((a, b) => b.date.localeCompare(a.date));
  const batch = opts.limit ? manifests.slice(0, opts.limit) : manifests;
  if (!batch.length) return;
  fitCliInfo(`\nUpgrading ${batch.length} runs from the JUnit in their S3 archives (the log names at most 3 failures per package)...`);
  for (const [i, m] of batch.entries()) {
    const a = await upgradeFromArchive(opts.store, m);
    summary.archiveRuns++;
    summary.archiveUpgraded += a.upgraded.length;
    fitCliInfo(`[${i + 1}/${batch.length}] ${m.date} run ${m.runId}: ${a.status}, ${a.upgraded.length} upgraded${a.skipped.length ? `, ${a.skipped.length} left as scraped` : ""}${a.reason ? ` (${a.reason})` : ""}`);
  }
}

export function backfillHelp(prefix: string): string {
  return `Fill in run records for an opted-in SDK's nightly runs that GitHub still holds.

Usage:
  ${prefix} <sdk> [--limit N] [--store <dir>] [--dry-run]

  --limit     Fetch at most N runs this pass (newest first). Rerun to continue.
  --store     Store: a directory, or s3://bucket/prefix/ for the shared store (default:
              ${defaultHealthStoreRoot()}, or $FIT_HEALTH_STORE).
  --dry-run   List what would be fetched; fetch nothing.
  --no-archives  Don't read JUnit from the runs' S3 archives (needs AWS credentials).

Two passes, both safe to rerun (anything already done is skipped):
  1. fetch each nightly's log with \`gh\` and scrape it (GitHub keeps logs 90 days);
  2. replace the scraped records with ones built from the full JUnit in the run's S3
     archive (kept 180 days) - the log names at most 3 failures per Java package.
Needs \`gh\` with read access to the SDK's repo, and AWS credentials for s3://fit-cli/runs/.`;
}

export async function runBackfillCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  const args = parseSdkCommandArgs(argv, { ...STORE_OPTION, limit: { type: "string" }, "dry-run": { type: "boolean" }, "no-archives": { type: "boolean" } }, backfillHelp(prefix));
  if (!args) return {};
  const { values, sdk } = args;
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit must be a positive integer");
  const dryRun = values["dry-run"] === true;
  const opened = await openStore(values.store, sdk);
  try {
    const store = opened.store;
    let s: BackfillSummary;
    try {
      s = await backfill(sdk, { store, limit, dryRun, skipArchives: values["no-archives"] === true });
    } finally {
      // Push whatever was done, even if a later run failed: every step is safe to redo.
      if (!dryRun) await opened.flush();
    }
    if (dryRun) {
      for (const r of s.pending) console.log(`  would fetch ${r.date} run ${r.runId}#${r.runAttempt}`);
      return {};
    }
    fitCliInfo(`\nFetched ${s.ingested} run logs → ${s.records} records; ${s.parseErrors} parse errors; ${s.fetchFailures} fetch failures.`);
    if (s.archiveRuns) fitCliInfo(`Upgraded ${s.archiveUpgraded} records from ${s.archiveRuns} runs' S3 archives.`);
    fitCliInfo(`Store: ${opened.location}`);
    const checks = checkStore(store, sdk);
    printWithoutTimestamps(`\n${renderChecks(checks)}`);
    if (!checks.pass) process.exitCode = 1;
    return {
      details: [
        { label: "Store", value: opened.location },
        { label: "Report", value: `fit health report ${sdk}` },
      ],
      artifacts: [],
    };
  } finally {
    opened.close();
  }
}

if (isMain(import.meta.url)) {
  runCli(() => runBackfillCommand(process.argv.slice(2), "bun src/fit/health/backfill/backfill.ts"));
}

