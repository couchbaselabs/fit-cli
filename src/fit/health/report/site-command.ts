#!/usr/bin/env node
/**
 * Build the health Pages site from one run's per-SDK reports: compare the SDKs (cross.ts),
 * write each SDK's page and the top page (overview.ts).
 *
 *   bun src/fit/health/report/site-command.ts --reports <dir> --out <site> [--previous <dir>]
 *
 * <reports> holds one directory per SDK, as the health workflow downloads them:
 * health-report-<sdk>/ with health-report.json. The site is written to <site>:
 *   index.html               redirects to health/
 *   .nojekyll                Pages serves the files as they are
 *   health/index.html        each SDK's last 30 nights, one chart each
 *   health/sdks.json         the SDKs on the site, for the next run
 *   health/<sdk>/index.html  the SDK's report page
 *   health/<sdk>/report.json the report data: what the page draws and tools read
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliInfo, fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { sdkByValue } from "../../../util/sdk/sdks.js";
import { loadOptIns } from "../registry/health-opt-ins.js";
import type { HealthReport } from "./build-report.js";
import { crossCompare } from "./cross.js";
import { buildOverview, type OverviewInput } from "./overview.js";
import { renderHtml, renderOverviewHtml } from "./render/render-html.js";
import { parseHealthArgs } from "../cli-args.js";

/** An SDK name as it may appear in a path or a URL. */
const SDK_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const REPORT_PREFIX = "health-report-";

const REDIRECT = `<!doctype html>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=health/">
<title>FIT Health</title>
<a href="health/">FIT Health</a>
`;

export function siteHelp(prefix: string): string {
  return `Build the health Pages site from one run's per-SDK reports.

Usage:
  ${prefix} --reports <dir> --out <site> [--previous <dir>]

  --reports   Holds a health-report-<sdk>/ directory (with health-report.json) per SDK that
              reported this run, as the health workflow downloads them.
  --out       The site is written here: each SDK's page and report.json under health/<sdk>/,
              the top page at health/, and a redirect to it at the root.
  --previous  The site as currently published (a checkout of fit-health's site branch). Each
              publish replaces the whole site, so an SDK with no report this run (a failed
              job, or a dispatch for one SDK) keeps its published page instead of vanishing.
              The page shows its own date, so a carried-over report never passes for a new one.

The SDKs reporting this run are compared with each other first (the same test on the other
SDKs: crossSdk on each test, and a line on its page).`;
}

/** This run's reports, by SDK. */
function readReports(dir: string): HealthReport[] {
  const reports: HealthReport[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.startsWith(REPORT_PREFIX) || !statSync(join(dir, entry)).isDirectory()) continue;
    const sdk = entry.slice(REPORT_PREFIX.length);
    const path = join(dir, entry, "health-report.json");
    if (!SDK_RE.test(sdk) || !existsSync(path)) {
      fitCliWarn(`skipping ${join(dir, entry)}: not an SDK report`);
      continue;
    }
    reports.push(JSON.parse(readFileSync(path, "utf8")) as HealthReport);
  }
  return reports;
}

/** Copy each SDK the published site lists and this run didn't report. Returns those kept. */
function carryOver(previous: string, health: string, have: ReadonlySet<string>): string[] {
  let listed: unknown;
  try {
    listed = JSON.parse(readFileSync(join(previous, "health", "sdks.json"), "utf8"));
  } catch {
    listed = undefined;
  }
  if (!Array.isArray(listed)) {
    fitCliInfo(`No published site in ${previous} yet: publishing this run's reports only.`);
    return [];
  }
  const kept: string[] = [];
  for (const sdk of listed) {
    if (typeof sdk !== "string" || !SDK_RE.test(sdk) || have.has(sdk)) continue;
    const from = join(previous, "health", sdk);
    if (!existsSync(join(from, "index.html"))) {
      fitCliWarn(`${sdk} had no report this run and has no published page; dropped`);
      continue;
    }
    mkdirSync(join(health, sdk), { recursive: true });
    copyFileSync(join(from, "index.html"), join(health, sdk, "index.html"));
    if (existsSync(join(from, "report.json"))) copyFileSync(join(from, "report.json"), join(health, sdk, "report.json"));
    fitCliInfo(`${sdk} had no report this run; keeping its published one`);
    kept.push(sdk);
  }
  return kept;
}

/**
 * The top page, from every SDK page under <site>/health: its report.json when it has one, else
 * a link only.
 */
async function writeOverview(health: string, sdks: readonly string[]): Promise<void> {
  const reports: { input: OverviewInput; name: string }[] = [];
  const missing: { sdk: string; name: string }[] = [];
  for (const sdk of sdks) {
    const name = sdkByValue(sdk)?.name ?? sdk;
    const path = join(health, sdk, "report.json");
    if (!existsSync(path)) {
      missing.push({ sdk, name });
      continue;
    }
    try {
      reports.push({ input: JSON.parse(readFileSync(path, "utf8")) as HealthReport, name });
    } catch (e) {
      fitCliWarn(`${sdk}: report.json could not be read (${(e as Error).message}); listed with a link only.`);
      missing.push({ sdk, name });
    }
  }
  const overview = buildOverview(reports, missing);
  writeFileSync(join(health, "index.html"), await renderOverviewHtml(overview));
  fitCliInfo(`Overview of ${overview.sdks.length + overview.missing.length} SDKs, ${overview.dates[0] ?? "-"} to ${overview.dates.at(-1) ?? "-"}.`);
}

/** Build the site. Returns the SDKs on it, sorted. */
export async function buildSite(reportsDir: string, siteDir: string, previous?: string): Promise<string[]> {
  const health = join(siteDir, "health");
  mkdirSync(health, { recursive: true });

  const reports = readReports(reportsDir);
  const optIns = loadOptIns();
  crossCompare(reports, Object.fromEntries(reports.map((r) => [r.sdk, optIns[r.sdk]?.family])));
  if (reports.length) fitCliInfo(`Compared ${reports.length} SDKs' reports: ${reports.map((r) => r.sdk).join(", ")}.`);
  for (const report of reports) {
    const dir = join(health, report.sdk);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.json"), JSON.stringify(report) + "\n");
    writeFileSync(join(dir, "index.html"), await renderHtml(report, sdkByValue(report.sdk)?.name ?? report.sdk));
  }

  const have = new Set(reports.map((r) => r.sdk));
  const carried = previous ? carryOver(previous, health, have) : [];
  const sdks = [...new Set([...have, ...carried])].sort();
  if (!sdks.length) throw new Error("no SDK reports to publish");

  writeFileSync(join(health, "sdks.json"), JSON.stringify(sdks) + "\n");
  await writeOverview(health, sdks);
  writeFileSync(join(siteDir, "index.html"), REDIRECT);
  writeFileSync(join(siteDir, ".nojekyll"), "");
  fitCliInfo(`Site: ${sdks.join(" ")}`);
  return sdks;
}

export async function runSiteCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  const { values, help } = parseHealthArgs(
    argv,
    { reports: { type: "string" }, out: { type: "string" }, previous: { type: "string" } },
    siteHelp(prefix),
    0,
  );
  if (help) {
    console.log(siteHelp(prefix));
    return {};
  }
  if (!values.reports || !values.out) throw new Error(siteHelp(prefix));
  await buildSite(values.reports, values.out, values.previous || undefined);
  return {};
}

if (isMain(import.meta.url)) {
  runCli(() => runSiteCommand(process.argv.slice(2), "bun src/fit/health/report/site-command.ts"));
}
