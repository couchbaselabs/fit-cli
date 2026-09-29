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
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
import { renderHtml } from "./render/render-html.js";
import { renderTerminal } from "./render/render-terminal.js";
import { renderSlackDigest } from "./render/render-slack.js";
import { readNotes } from "./notes.js";
import { renderMarkdown } from "./render/render-markdown.js";
import { appendFileSync } from "node:fs";
import { postDigest } from "./post-digest.js";
import { healthOptIn } from "../registry/health-opt-ins.js";

export function reportHelp(prefix: string): string {
  return `Report which FIT tests fail consistently or intermittently for an SDK, from its stored run records.

Usage:
  ${prefix} <sdk> [--end YYYY-MM-DD] [--days N] [--store <dir>] [--notes <file>]
                 [--slack | --no-slack | --slack-dry-run | --slack-channel <id>]

  --end            Report as of this date (default: the latest night in the store).
  --days           How many calendar days, ending at --end, the report looks at (default: ${HISTORY_DAYS}).
                   The store keeps every night; this only bounds the report.
  --store          Store: a directory, or s3://bucket/prefix/ (default: ${defaultHealthStoreRoot()}, or $FIT_HEALTH_STORE).
  --notes          Read hand-written notes ({fixes}) from this file instead of the store (see fit health notes).
  --out            Also write health-report.json, .html and slack-digest.txt into this directory.
  --slack          Post the digest to the SDK's configured Slack channel (in CI this is the default).
  --no-slack       Don't post, even in CI.
  --slack-dry-run  Print the Slack digest instead of posting it.
  --slack-channel  Post to this channel or user ID instead of the configured one (implies --slack).

Writes health-report.json, health-report.html and slack-digest.txt to the run's artifact
directory. Posts the digest to Slack only when a channel is configured (the SDK's opt-in in
health-opt-ins.ts has a \`slack\` block, or --slack-channel is given) AND either this is CI or
--slack was passed - so a local run never posts by accident.
Fill the store first with \`fit health backfill <sdk>\`.`;
}

export type SlackDecision =
  | { post: true; channel: string }
  | { post: false; dryRun: boolean; why: string; channel?: string };

/**
 * Whether to post the digest. Configuring a channel enables Slack for an SDK; it then posts
 * automatically in CI (GITHUB_ACTIONS), but a local run must ask with --slack, so someone
 * trying the report on a laptop never posts to the team's channel by accident.
 */
export function slackDecision(argv: string[], configuredChannel: string | undefined, env: NodeJS.ProcessEnv): SlackDecision {
  const i = argv.indexOf("--slack-channel");
  const override = i >= 0 ? argv[i + 1] : undefined;
  const channel = override ?? configuredChannel;
  if (argv.includes("--slack-dry-run")) return { post: false, dryRun: true, why: "dry run", channel };
  if (argv.includes("--no-slack")) return { post: false, dryRun: false, why: "--no-slack given" };
  if (!channel) return { post: false, dryRun: false, why: "no Slack channel configured for this SDK (add a slack block to its opt-in)" };
  const ci = env.GITHUB_ACTIONS === "true";
  if (!ci && !argv.includes("--slack") && !override) {
    return { post: false, dryRun: false, why: `a channel is configured, but this is a local run - pass --slack to post to ${channel}` };
  }
  return { post: true, channel };
}

export async function runReportCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(reportHelp(prefix));
    return {};
  }
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sdk = argv.find((a, i) => !a.startsWith("-") && !argv[i - 1]?.startsWith("--"));
  if (!sdk) throw new Error(reportHelp(prefix));
  // Everything the report needs is read up front, so the store is closed straight after.
  const { store, location, close } = await openStore(opt("store") ?? process.env.FIT_HEALTH_STORE, sdk, { skipRawLogs: true });
  let records: RunRecord[], manifests: RunManifest[], notes: ReportNotes;
  try {
    records = store.readRecords(sdk);
    if (records.length === 0) throw new Error(`No run records for ${sdk} in ${location}. Run \`fit health backfill ${sdk}\` first.`);
    manifests = store.list(`${sdk}/manifests`).map((k) => JSON.parse(store.read(k)!.toString("utf8")) as RunManifest);
    // Notes live in the store (fit health notes); --notes reads a file instead, for trying them out.
    const notesFile = opt("notes");
    notes = notesFile ? (JSON.parse(readFileSync(notesFile, "utf8")) as ReportNotes) : readNotes(store, sdk);
  } finally {
    close();
  }

  const daysArg = opt("days");
  const days = daysArg === undefined ? undefined : Number(daysArg);
  if (days !== undefined && (!Number.isInteger(days) || days < 1)) throw new Error(`--days must be a whole number of days, at least 1; got ${daysArg}`);
  const report = buildHealthReport(sdk, records, manifests, { end: opt("end"), days, notes });
  printWithoutTimestamps(renderTerminal(report));

  const sdkName = sdkByValue(sdk)?.name ?? sdk;
  const runDir = ensureRunDir();
  const jsonPath = join(runDir, "health-report.json");
  const htmlPath = join(runDir, "health-report.html");
  const digestPath = join(runDir, "slack-digest.txt");
  writeFileSync(jsonPath, JSON.stringify(report, null, 1) + "\n");
  writeFileSync(htmlPath, await renderHtml(report, sdkName));

  // In GitHub Actions, the job summary shows the result on the workflow run page.
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report, sdkName));

  const slack = healthOptIn(sdk)?.slack;
  const digest = renderSlackDigest(report, sdkName, slack?.reportUrl);
  writeFileSync(digestPath, `${digest.headline}\n\n--- thread ---\n${digest.thread}\n`);
  const out = opt("out");
  if (out) {
    mkdirSync(out, { recursive: true });
    for (const p of [jsonPath, htmlPath, digestPath]) copyFileSync(p, join(out, basename(p)));
  }
  const details = [{ label: "Open", value: `open ${htmlPath}` }];
  const decision = slackDecision(argv, slack?.channel, process.env);
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
    // Kept as the workflow's health-report-<sdk> artifact and on Pages; s3://fit-cli/runs/ is for FIT runs.
    artifactsKeptElsewhere: true,
    artifacts: [
      artifactFromPath(jsonPath, "The health report (derived from the run records; regenerate at will)", runDir),
      artifactFromPath(htmlPath, "The health report as a page", runDir),
      artifactFromPath(digestPath, "The Slack digest (headline, then the thread reply)", runDir),
    ],
    details,
  };
}

if (isMain(import.meta.url)) {
  runCli(() => runReportCommand(process.argv.slice(2), "bun src/fit/health/report/report.ts"));
}
