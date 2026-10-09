#!/usr/bin/env node
/**
 * Build the health report for an SDK from its stored run records.
 *
 *   bun src/fit/health/report/report.ts <sdk> [--end YYYY-MM-DD] [--days N] [--store <dir>] [--notes <file>]
 *
 * Prints the terminal view and writes health-report.json and health-report.html to the run's
 * artifact directory. Notes (hand-written cross-SDK observations and known fixes) are read from
 * <store>/<sdk>/notes.json when present.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFromPath, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliInfo, fitCliWarn, printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import { sdkByValue } from "../../../util/sdk/sdks.js";
import type { RunManifest } from "../record/run-manifest.js";
import type { RunRecord } from "../record/run-record.js";
import { defaultHealthStoreRoot } from "../store/health-store.js";
import { openStore } from "../store/s3-store.js";
import { HISTORY_DAYS, buildHealthReport, type ReportNotes } from "./build-report.js";
import { analyseChanges } from "./changes.js";
import { githubChanges } from "./github-changes.js";
import { renderHtml } from "./render/render-html.js";
import { renderTerminal } from "./render/render-terminal.js";
import { renderSlackDigest } from "./render/render-slack.js";
import { readNotes } from "./notes.js";
import { readSettings, reportUrlFor, type HealthSettings } from "./settings.js";
import { renderMarkdown } from "./render/render-markdown.js";
import { appendFileSync } from "node:fs";
import { postDigest } from "./post-digest.js";
import { healthOptIn } from "../registry/health-opt-ins.js";
import { STORE_OPTION, parseSdkCommandArgs } from "../cli-args.js";

export function reportHelp(prefix: string): string {
  return `Report which FIT tests fail consistently or intermittently for an SDK, from its stored run records.

Usage:
  ${prefix} <sdk> [--end YYYY-MM-DD] [--days N] [--store <dir>] [--notes <file>]
                 [--slack | --no-slack | --slack-dry-run | --slack-channel <id>]

  --end            Report as of this date (default: the latest night in the store).
  --days           How many calendar days, ending at --end, the report looks at (default: ${HISTORY_DAYS}).
                   The store keeps every night; this only bounds the report.
  --no-changes     Don't look up the SDK and FIT driver commits around each change (needs GitHub).
  --store          Store: a directory, or s3://bucket/prefix/ (default: ${defaultHealthStoreRoot()}, or $FIT_HEALTH_STORE).
  --notes          Read hand-written notes ({fixes}) from this file instead of the store (see fit health notes).
  --out            Write health-report.json, .html and slack-digest.txt into this directory instead.
  --slack          Post the digest to the SDK's Slack channel (set with fit health settings).
  --no-slack       Don't post (the default); overrides --slack.
  --slack-dry-run  Print the Slack digest instead of posting it.
  --slack-channel  Post to this channel or user ID instead of the configured one (implies --slack).

Writes health-report.json, health-report.html and slack-digest.txt to the run's artifact
directory, or to --out. Written to --out, they aren't run artifacts: the health workflow keeps
them as a GitHub artifact and on Pages, so the run directory isn't uploaded to S3. Posts the digest to Slack only when asked, with --slack (and the SDK has a channel
set with \`fit health settings <sdk> --slack-channel <id>\`) or --slack-channel - so a run
never posts by accident.
Fill the store first with \`fit health backfill <sdk>\`.`;
}

export type SlackDecision =
  | { post: true; channel: string }
  | { post: false; dryRun: boolean; why: string; channel?: string };

/**
 * Whether to post the digest: only when asked, with --slack (to the SDK's configured channel)
 * or --slack-channel. The scheduled workflow passes --slack; nothing else posts by default.
 */
export interface SlackFlags {
  slack?: boolean;
  "no-slack"?: boolean;
  "slack-dry-run"?: boolean;
  "slack-channel"?: string;
}

export function slackDecision(flags: SlackFlags, configuredChannel: string | undefined): SlackDecision {
  const override = flags["slack-channel"];
  const channel = override ?? configuredChannel;
  if (flags["slack-dry-run"]) return { post: false, dryRun: true, why: "dry run", channel };
  if (flags["no-slack"]) return { post: false, dryRun: false, why: "--no-slack given" };
  if (!channel) return { post: false, dryRun: false, why: "no Slack channel configured for this SDK (set one with `fit health settings <sdk> --slack-channel <id>`)" };
  if (!flags.slack && !override) return { post: false, dryRun: false, why: `--slack not given (it would post to ${channel})` };
  return { post: true, channel };
}

export async function runReportCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  const args = parseSdkCommandArgs(
    argv,
    {
      ...STORE_OPTION,
      notes: { type: "string" },
      days: { type: "string" },
      end: { type: "string" },
      out: { type: "string" },
      "no-changes": { type: "boolean" },
      slack: { type: "boolean" },
      "no-slack": { type: "boolean" },
      "slack-dry-run": { type: "boolean" },
      "slack-channel": { type: "string" },
    },
    reportHelp(prefix),
  );
  if (!args) return {};
  const { values, sdk } = args;
  // Everything the report needs is read up front, so the store is closed straight after.
  const { store, location, close } = await openStore(values.store, sdk, { skipRawLogs: true });
  let records: RunRecord[], manifests: RunManifest[], notes: ReportNotes, settings: HealthSettings;
  try {
    records = store.readRecords(sdk);
    if (records.length === 0) throw new Error(`No run records for ${sdk} in ${location}. Run \`fit health backfill ${sdk}\` first.`);
    manifests = store.listManifests(sdk);
    // Notes live in the store (fit health notes); --notes reads a file instead, for trying them out.
    const notesFile = values.notes;
    notes = notesFile ? (JSON.parse(readFileSync(notesFile, "utf8")) as ReportNotes) : readNotes(store, sdk);
    // Where the output goes (fit health settings), from the same store.
    settings = readSettings(store, sdk);
  } finally {
    close();
  }

  const daysArg = values.days;
  const days = daysArg === undefined ? undefined : Number(daysArg);
  if (days !== undefined && (!Number.isInteger(days) || days < 1)) throw new Error(`--days must be a whole number of days, at least 1; got ${daysArg}`);
  const report = buildHealthReport(sdk, records, manifests, { end: values.end, days, notes });
  printWithoutTimestamps(renderTerminal(report));

  const sdkName = sdkByValue(sdk)?.name ?? sdk;
  const runDir = ensureRunDir();
  const outDir = values.out ?? runDir;
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "health-report.json");
  const htmlPath = join(outDir, "health-report.html");
  const digestPath = join(outDir, "slack-digest.txt");
  // What changed around each change point, in the SDK and in the FIT driver: needs GitHub.
  const optIn = healthOptIn(sdk);
  if (optIn && !values["no-changes"]) {
    const r = await analyseChanges(report, { optIn, source: githubChanges });
    fitCliInfo(`Changes: looked up the SDK and driver commits for ${r.analysed} tests${r.failed ? ` (${r.failed} couldn't be: see changeAnalysis in health-report.json)` : ""}.`);
  }
  writeFileSync(jsonPath, JSON.stringify(report) + "\n");
  writeFileSync(htmlPath, await renderHtml(report, sdkName));

  // In GitHub Actions, the job summary shows the result on the workflow run page.
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report, sdkName));

  const slack = settings.slack;
  const digest = renderSlackDigest(report, sdkName, reportUrlFor(sdk, settings));
  writeFileSync(digestPath, `${digest.headline}\n\n--- thread ---\n${digest.thread}\n`);
  const details = [{ label: "Open", value: `open ${htmlPath}` }];
  const decision = slackDecision(values, slack?.channel);
  if (decision.post) {
    // Posting is a side effect of the report, never a reason for it to fail.
    try {
      await postDigest(decision.channel, digest);
      fitCliInfo(`Slack: posted the digest to ${decision.channel}.`);
      details.push({ label: "Slack", value: `posted to ${decision.channel}` });
    } catch (err) {
      const message = `Slack: could not post the digest to ${decision.channel}: ${err instanceof Error ? err.message : String(err)}`;
      fitCliWarn(message);
      // In Actions, also as a warning annotation, so it shows on the run page - never as a failure.
      if (process.env.GITHUB_ACTIONS === "true") console.log(`::warning title=FIT health Slack digest::${message.replace(/\r?\n/g, " ")}`);
      details.push({ label: "Slack", value: "not posted (warning)" });
    }
  } else if (decision.dryRun) {
    printWithoutTimestamps(`\nSlack digest (dry run, not posted${decision.channel ? ` - would go to ${decision.channel}` : ""}):\n\n${digest.headline}\n\n--- thread ---\n${digest.thread}`);
  } else {
    fitCliInfo(`Slack: not posting - ${decision.why}.`);
  }
  return {
    artifacts: values.out
      ? []
      : [
          artifactFromPath(jsonPath, "The health report: what the page draws and what tools read (fields in specs/health.md)", runDir),
          artifactFromPath(htmlPath, "The health report as a page", runDir),
          artifactFromPath(digestPath, "The Slack digest (headline, then the thread reply)", runDir),
        ],
    details,
  };
}

if (isMain(import.meta.url)) {
  runCli(() => runReportCommand(process.argv.slice(2), "bun src/fit/health/report/report.ts"));
}
