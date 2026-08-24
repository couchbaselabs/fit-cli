#!/usr/bin/env node
/**
 * fit ingest loads run results uploaded to S3 into the Postgres results database.
 *
 *   fit ingest situational
 *
 * situational: drains s3://<bucket>/incoming/ into the results database, moves each run
 *              directory to processed/ or failed/, and records one ingester_runs report row.
 *
 * Made to be run from a cron on the instance that hosts the results database, so the
 * database credentials come from the environment or from a ./.env file placed there.
 */
import { S3Client } from "@aws-sdk/client-s3";
import postgres from "postgres";
import { AWS_REGION } from "../../cloud/util/aws/aws-target.js";
import { RESULTS_BUCKET } from "../situational/upload-results/upload-results.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { loadDotenv } from "../../util/non-fit/dotenv.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { resolvedGitSha } from "../version/version.js";
import { Db, type ReportStatus, type RunData } from "./db.js";
import {
  isUuid,
  parseBucketsCsv,
  parseEventsCsv,
  parseMetricsCsv,
  parseRunJson5,
  parseScoresJson5,
} from "./parse.js";
import { FAILED_PREFIX, type IncomingRun, PROCESSED_PREFIX, S3Queue } from "./s3-queue.js";

// The ingest always runs on the instance that hosts the results database.
const RESULTS_DB_HOST = "localhost";
const DEFAULT_USERNAME = "results_writer";
const RESULTS_DB_PORT = 5432;
const RESULTS_DB_NAME = "perf";

interface RunOutcome {
  sit: string;
  run: string;
  kind?: string;
  outcome: "ingested" | "failed" | "deferred";
  movedTo?: string;
  error?: string;
  rows?: { buckets: number; metrics: number; events: number };
}

/** Only a real failure makes a run partial. Deferrals are normal, an upload can still be in flight. */
export function overallStatus(outcomes: RunOutcome[]): "success" | "partial" | "nothing_to_do" {
  if (outcomes.length === 0) return "nothing_to_do";
  return outcomes.some((o) => o.outcome === "failed") ? "partial" : "success";
}

interface IngestSettings {
  username: string;
  password: string;
}

/**
 * Read the database credentials from the environment, after pulling in any
 * ./.env. Real exported variables win over the file.
 */
function resolveSettings(): IngestSettings {
  loadDotenv();
  const password = process.env.CB_DATABASE_PASSWORD;
  if (!password) {
    throw new Error(
      "CB_DATABASE_PASSWORD is not set. Export it, or put it in a .env file in the directory you run this from.",
    );
  }
  return {
    username: process.env.CB_DATABASE_USERNAME ?? DEFAULT_USERNAME,
    password,
  };
}

/** Throwing here is a permanent failure, so the run moves to failed/. */
async function loadRun(queue: S3Queue, incoming: IncomingRun): Promise<RunData> {
  const sitUuid = incoming.sitSegment.toLowerCase();
  if (!isUuid(sitUuid)) throw new Error(`Situational run path segment is not a UUID: ${incoming.sitSegment}`);
  if (!isUuid(incoming.runSegment.toLowerCase())) {
    throw new Error(`Run path segment is not a UUID: ${incoming.runSegment}`);
  }

  const fileByName = new Map(incoming.files.map((f) => [f.key.split("/").slice(3).join("/"), f]));
  const runJson5 = fileByName.get("run.json5");
  if (runJson5 === undefined) throw new Error("no run.json5");

  const run = parseRunJson5(await queue.getText(runJson5.key));
  if (run.runUuid !== incoming.runSegment.toLowerCase()) {
    throw new Error(`run.json5 is for run ${run.runUuid}, not this directory`);
  }

  const optionalText = async (name: string): Promise<string | undefined> => {
    const file = fileByName.get(name);
    return file === undefined ? undefined : await queue.getText(file.key);
  };

  const bucketsText = await optionalText("buckets.csv");
  const metricsText = await optionalText("metrics.csv");
  const eventsText = await optionalText("events.csv");

  return {
    sitUuid,
    run,
    datetime: runJson5.lastModified,
    scores: parseScoresJson5(await optionalText("scores.json5")),
    buckets: bucketsText === undefined ? [] : parseBucketsCsv(bucketsText),
    metrics: metricsText === undefined ? [] : parseMetricsCsv(metricsText),
    events: eventsText === undefined ? [] : parseEventsCsv(eventsText),
  };
}

async function processRun(queue: S3Queue, db: Db, incoming: IncomingRun): Promise<RunOutcome> {
  const outcome: RunOutcome = { sit: incoming.sitSegment, run: incoming.runSegment, outcome: "deferred" };

  // A missing run.json5 can mean the upload is still in flight, so defer. A
  // directory that stays like this shows up in every report.
  if (!incoming.files.some((f) => f.key.endsWith("/run.json5"))) {
    outcome.error = "no run.json5 (yet)";
    return outcome;
  }

  const keysAtIngest = incoming.files.map((f) => f.key).sort();

  let data: RunData;
  try {
    data = await loadRun(queue, incoming);
  } catch (err) {
    outcome.outcome = "failed";
    outcome.error = (err as Error).message;
    outcome.movedTo = await queue.moveRun(incoming, FAILED_PREFIX, new Date());
    return outcome;
  }

  outcome.kind = data.run.kind;
  outcome.rows = { buckets: data.buckets.length, metrics: data.metrics.length, events: data.events.length };
  await db.ingestRun(data);

  // The uploader sends files one at a time, so this listing may have caught a
  // directory mid-upload. If it grew since, leave it. The next tick re-ingests
  // the whole directory and moves it then.
  const keysNow = await queue.listRunKeys(incoming);
  if (keysNow.join("\n") !== keysAtIngest.join("\n")) {
    outcome.error = "upload still in flight (directory changed during ingest)";
    return outcome;
  }

  outcome.movedTo = await queue.moveRun(incoming, PROCESSED_PREFIX, new Date());
  outcome.outcome = "ingested";
  return outcome;
}

function countsOf(outcomes: RunOutcome[], failedBacklog: number | null) {
  return {
    ingested: outcomes.filter((o) => o.outcome === "ingested").length,
    failed: outcomes.filter((o) => o.outcome === "failed").length,
    deferred: outcomes.filter((o) => o.outcome === "deferred").length,
    failedBacklog,
  };
}

async function cmdSituational(argv: string[]): Promise<{ status: ReportStatus; outcomes: RunOutcome[] }> {
  if (argv.length > 0) {
    console.error(`Usage: ${runScriptPrefix("ingest")} situational`);
    process.exit(2);
  }

  const settings = resolveSettings();
  const sql = postgres({
    host: RESULTS_DB_HOST,
    port: RESULTS_DB_PORT,
    database: RESULTS_DB_NAME,
    username: settings.username,
    password: settings.password,
    max: 1,
  });
  const db = new Db(sql);
  // Ambient credentials, not the shared fit-cli-role client. On the server the
  // instance role holds the results-queue permissions, and fit-cli-role does not.
  const queue = new S3Queue(new S3Client({ region: AWS_REGION }), RESULTS_BUCKET);

  const reportId = await db.startReport();
  console.log(`Ingester run ${reportId} started (bucket ${RESULTS_BUCKET})`);

  const outcomes: RunOutcome[] = [];
  let status: ReportStatus;
  try {
    const listing = await queue.listIncoming();
    const strayKeys = listing.strayKeys;

    for (const incoming of listing.runs) {
      let outcome: RunOutcome;
      try {
        outcome = await processRun(queue, db, incoming);
      } catch (err) {
        // Treat DB and S3 errors as transient and leave the run in incoming/ for the next tick.
        outcome = {
          sit: incoming.sitSegment,
          run: incoming.runSegment,
          outcome: "deferred",
          error: (err as Error).message,
        };
      }
      console.log(`${outcome.outcome}: ${outcome.sit}/${outcome.run}${outcome.error ? ` (${outcome.error})` : ""}`);
      outcomes.push(outcome);
    }

    const failedBacklog = await queue.countFailedBacklog().catch(() => null);
    status = overallStatus(outcomes);
    await db.finishReport(reportId, status, countsOf(outcomes, failedBacklog), {
      version: resolvedGitSha(),
      bucket: RESULTS_BUCKET,
      runs: outcomes,
      ...(strayKeys.length > 0 ? { strayKeys } : {}),
    });
  } catch (err) {
    await db
      .finishReport(reportId, "failed", countsOf(outcomes, null), {
        version: resolvedGitSha(),
        bucket: RESULTS_BUCKET,
        runs: outcomes,
        error: (err as Error).message,
      })
      .catch(() => {});
    throw err;
  } finally {
    await sql.end();
  }
  console.log(`Ingester run ${reportId} finished: ${status}`);
  return { status, outcomes };
}

function helpText(): string {
  const p = runScriptPrefix("ingest");
  return `Ingest S3 run results into the results database.

Usage:
  ${p} situational
  ${p} --help

Subcommands:
  situational  Drain s3://${RESULTS_BUCKET}/incoming/ into the results database. Each run
               directory then moves to processed/ or failed/, and one ingester_runs row
               records what happened.
  performance  Not implemented yet.

The database is always ${RESULTS_DB_NAME} on ${RESULTS_DB_HOST}:${RESULTS_DB_PORT}. Credentials come from
the environment, or from a .env file in the current directory:
  CB_DATABASE_PASSWORD  Password for the database user. Required.
  CB_DATABASE_USERNAME  Database user. Defaults to "${DEFAULT_USERNAME}".`;
}

export function runIngestMain(): void {
  const [subcommand, ...rest] = process.argv.slice(2);

  runCli(async () => {
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      console.log(helpText());
      if (!subcommand) process.exit(2);
      return;
    }

    if (subcommand === "situational") {
      const { status, outcomes } = await cmdSituational(rest);
      return {
        artifacts: [],
        details: [
          { label: "Status", value: status },
          { label: "Ingested", value: String(outcomes.filter((o) => o.outcome === "ingested").length) },
          { label: "Failed", value: String(outcomes.filter((o) => o.outcome === "failed").length) },
          { label: "Deferred", value: String(outcomes.filter((o) => o.outcome === "deferred").length) },
        ],
      };
    }

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(helpText());
    process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runIngestMain();
}
