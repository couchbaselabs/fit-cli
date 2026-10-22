#!/usr/bin/env node
/**
 * Build the weekly wrap-up (weekly.ts) into the health site, and post it to Slack.
 *
 *   bun src/fit/health/report/weekly-command.ts --out <site> [--week YYYY-Www] [--weeks N] [--store <dir>]
 *
 * Each opted-in SDK's report is rebuilt as of each week's Sunday, and the week before's, from
 * the store. The week is written to <site>/health/weekly/:
 *   <week>/index.html  the week's page, frozen: never rebuilt once it exists (unless --rebuild)
 *   <week>/week.json   the page's data
 *   latest/index.html  a copy of the newest week's page
 *   index.html         every week, newest first
 *   index.json         every week, for the pages' previous/next/latest links
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliInfo, fitCliWarn, printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { sdkByValue } from "../../../util/sdk/sdks.js";
import { HEALTH_OPT_INS } from "../registry/health-opt-ins.js";
import { defaultHealthStoreRoot } from "../store/health-store.js";
import { openStore } from "../store/s3-store.js";
import { STORE_OPTION, parseHealthArgs } from "../cli-args.js";
import { buildHealthReport, type HealthReport } from "./build-report.js";
import { addDays } from "./dates.js";
import { readNotes } from "./notes.js";
import { postDigest } from "./post-digest.js";
import { renderWeeklyHtml, renderWeeklyIndexHtml } from "./render/render-html.js";
import { renderSlackWeekly } from "./render/render-slack-weekly.js";
import { healthSiteUrl } from "./settings.js";
import { buildWeekly, isoWeek, isoWeekById, lastFullWeek, weekEntry, type WeekEntry, type Weekly } from "./weekly.js";

export function weeklyHelp(prefix: string): string {
  return `Build the weekly wrap-up into the health site: each SDK's week against the week before.

Usage:
  ${prefix} --out <site> [--week YYYY-Www] [--weeks N] [--rebuild] [--store <dir>]
                 [--slack-channel <id> | --slack-dry-run]

  --out            The site, as \`fit health site\` built it: the week goes in health/weekly/.
  --week           The week to build (default: the last full week, Monday to Sunday).
  --weeks          Also build the N-1 weeks before it, e.g. to fill in the weeks the store
                   already covers (default: 1). Only the newest is posted to Slack.
  --rebuild        Rebuild a week that is already in the site. A week is frozen once built,
                   so a rerun for the same week changes nothing and posts nothing.
  --store          Store: a directory, or s3://bucket/prefix/ (default: ${defaultHealthStoreRoot()}, or $FIT_HEALTH_STORE).
  --slack-channel  Post the newest week to this channel or user ID, when it was built this run.
  --slack-dry-run  Print the Slack message instead of posting it.

Every opted-in SDK's report is rebuilt as of each week's Sunday from the store; nothing is
written to the store.`;
}

const WEEK_RE = /^\d{4}-W\d{2}$/;

/** The weeks already in the site: those with a week.json, oldest first. */
export function readWeeks(weeklyDir: string): WeekEntry[] {
  if (!existsSync(weeklyDir)) return [];
  const out: WeekEntry[] = [];
  for (const id of readdirSync(weeklyDir).filter((d) => WEEK_RE.test(d)).sort()) {
    try {
      out.push(weekEntry(JSON.parse(readFileSync(join(weeklyDir, id, "week.json"), "utf8")) as Weekly));
    } catch {
      fitCliWarn(`weekly/${id} has no readable week.json; left out of the index`);
    }
  }
  return out;
}

/**
 * Write one week's page, unless the site already has it (and `rebuild` is false). Returns
 * whether it was written.
 */
export async function writeWeek(weeklyDir: string, weekly: Weekly, rebuild = false): Promise<boolean> {
  const dir = join(weeklyDir, weekly.week.id);
  if (existsSync(join(dir, "index.html")) && !rebuild) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), await renderWeeklyHtml(weekly));
  writeFileSync(join(dir, "week.json"), JSON.stringify(weekly) + "\n");
  return true;
}

/** The index (page and JSON) and latest/, from the weeks now in the site. */
export async function writeIndex(weeklyDir: string): Promise<WeekEntry[]> {
  const weeks = readWeeks(weeklyDir);
  mkdirSync(weeklyDir, { recursive: true });
  writeFileSync(join(weeklyDir, "index.json"), JSON.stringify({ weeks }) + "\n");
  writeFileSync(join(weeklyDir, "index.html"), await renderWeeklyIndexHtml([...weeks].reverse()));
  const newest = weeks.at(-1);
  if (newest) {
    mkdirSync(join(weeklyDir, "latest"), { recursive: true });
    copyFileSync(join(weeklyDir, newest.id, "index.html"), join(weeklyDir, "latest", "index.html"));
  }
  return weeks;
}

/** An SDK's report as of `end`, or undefined when the store has no night in its span. */
function reportAt(sdk: string, data: Parameters<typeof buildHealthReport>, end: string): HealthReport | undefined {
  const [, records, manifests, opts] = data;
  const report = buildHealthReport(sdk, records, manifests, { ...opts, end });
  return report.dates.length ? report : undefined;
}

export async function runWeeklyCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  const { values, help } = parseHealthArgs(
    argv,
    {
      ...STORE_OPTION,
      out: { type: "string" },
      week: { type: "string" },
      weeks: { type: "string" },
      rebuild: { type: "boolean" },
      "slack-channel": { type: "string" },
      "slack-dry-run": { type: "boolean" },
    },
    weeklyHelp(prefix),
    0,
  );
  if (help) {
    console.log(weeklyHelp(prefix));
    return {};
  }
  if (!values.out) throw new Error(weeklyHelp(prefix));
  const newest = values.week ? isoWeekById(values.week) : lastFullWeek(new Date().toISOString().slice(0, 10));
  if (!newest) throw new Error(`--week must be an ISO week like 2026-W43; got ${values.week}`);
  const count = values.weeks === undefined ? 1 : Number(values.weeks);
  if (!Number.isInteger(count) || count < 1 || count > 52) throw new Error(`--weeks must be a whole number from 1 to 52; got ${values.weeks}`);
  const weeks = Array.from({ length: count }, (_, k) => isoWeek(addDays(newest.start, -7 * (count - 1 - k))));
  const weeklyDir = join(values.out, "health", "weekly");
  const todo = weeks.filter((w) => values.rebuild || !existsSync(join(weeklyDir, w.id, "index.html")));
  if (!todo.length) fitCliInfo(`Every week asked for is already in the site (${weeks.map((w) => w.id).join(", ")}): nothing to build.`);

  // Every committed opt-in, in the store: each SDK's records are read once for all its weeks.
  const sdks = Object.keys(HEALTH_OPT_INS).sort();
  const reports = new Map<string, Map<string, HealthReport | undefined>>();
  if (todo.length) {
    const ends = [...new Set(todo.flatMap((w) => [w.end, addDays(w.start, -1)]))];
    for (const sdk of sdks) {
      const at = new Map<string, HealthReport | undefined>();
      reports.set(sdk, at);
      const { store, close } = await openStore(values.store, sdk, { skipRawLogs: true });
      try {
        const records = store.readRecords(sdk);
        const data: Parameters<typeof buildHealthReport> = [sdk, records, store.listManifests(sdk), { notes: readNotes(store, sdk) }];
        for (const end of ends) at.set(end, records.length ? reportAt(sdk, data, end) : undefined);
      } finally {
        close();
      }
    }
  }

  const built: Weekly[] = [];
  for (const week of todo) {
    const weekly = buildWeekly(
      sdks.map((sdk) => ({
        sdk,
        name: sdkByValue(sdk)?.name ?? sdk,
        current: reports.get(sdk)?.get(week.end),
        previous: reports.get(sdk)?.get(addDays(week.start, -1)),
      })),
      week,
      new Date(),
      HEALTH_OPT_INS,
    );
    await writeWeek(weeklyDir, weekly, values.rebuild);
    built.push(weekly);
    fitCliInfo(`${week.id}: ${weekEntry(weekly).changed} of ${weekly.cards.length} SDKs with something to report.`);
  }
  const index = await writeIndex(weeklyDir);
  if (index.length) fitCliInfo(`Weekly index: ${index.length} weeks, newest ${index.at(-1)!.id}.`);

  // Slack: only the newest week asked for, and only when this run built it.
  const post = built.find((w) => w.week.id === newest.id);
  const channel = values["slack-channel"];
  if (!post) {
    if (channel || values["slack-dry-run"]) fitCliInfo(`Slack: not posting - ${newest.id} was not built this run.`);
    return {};
  }
  // The site's address comes from GitHub (private Pages gets a random hostname): without it,
  // the message would have no link to the page.
  const site = await healthSiteUrl();
  if (!site) fitCliWarn("Slack: could not find the health site's address (gh api repos/couchbaselabs/fit-health/pages): the message has no links.");
  const message = renderSlackWeekly(post, site ? `${site}weekly/${post.week.id}/` : undefined);
  if (values["slack-dry-run"]) {
    printWithoutTimestamps(`\nSlack message (dry run, not posted${channel ? ` - would go to ${channel}` : ""}):\n\n${message}`);
  } else if (channel) {
    // Posting is a side effect of the page, never a reason for it to fail.
    try {
      await postDigest(channel, { headline: message });
      fitCliInfo(`Slack: posted ${post.week.id} to ${channel}.`);
    } catch (err) {
      const text = `Slack: could not post ${post.week.id} to ${channel}: ${err instanceof Error ? err.message : String(err)}`;
      fitCliWarn(text);
      if (process.env.GITHUB_ACTIONS === "true") console.log(`::warning title=FIT health weekly Slack::${text.replace(/\r?\n/g, " ")}`);
    }
  } else {
    fitCliInfo("Slack: not posting - no --slack-channel given.");
  }
  return {};
}

if (isMain(import.meta.url)) {
  runCli(() => runWeeklyCommand(process.argv.slice(2), "bun src/fit/health/report/weekly-command.ts"));
}
