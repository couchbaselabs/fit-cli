#!/usr/bin/env node
/**
 * Write the health site's top page: every SDK's last nights, one chart each (see overview.ts).
 *
 *   bun src/fit/health/report/overview-command.ts --dir <site>/health
 *
 * <site>/health holds one directory per SDK, as health-site.sh lays them out: <sdk>/index.html
 * (its page) and <sdk>/report.json (its report). Writes index.html and overview.json there.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliInfo, fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { sdkByValue } from "../../../util/sdk/sdks.js";
import type { HealthReport } from "./build-report.js";
import { buildOverview, type OverviewInput } from "./overview.js";
import { renderOverviewHtml } from "./render/render-html.js";
import { parseHealthArgs } from "../cli-args.js";

export function overviewHelp(prefix: string): string {
  return `Write the health site's top page: each SDK's last nights, one chart per SDK.

Usage:
  ${prefix} --dir <site>/health

<site>/health holds <sdk>/index.html and <sdk>/report.json for each SDK, as the health
workflow lays out the site. Writes index.html (the page) and overview.json (its data) there.
An SDK with a page but no report.json is listed with a link only.`;
}

export async function runOverviewCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  const { values, help } = parseHealthArgs(argv, { dir: { type: "string" } }, overviewHelp(prefix), 0);
  if (help) {
    console.log(overviewHelp(prefix));
    return {};
  }
  const { dir } = values;
  if (!dir) throw new Error(overviewHelp(prefix));
  const reports: { input: OverviewInput; name: string }[] = [];
  const missing: { sdk: string; name: string }[] = [];
  for (const sdk of readdirSync(dir).sort()) {
    if (!statSync(join(dir, sdk)).isDirectory() || !existsSync(join(dir, sdk, "index.html"))) continue;
    const name = sdkByValue(sdk)?.name ?? sdk;
    const path = join(dir, sdk, "report.json");
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
  writeFileSync(join(dir, "overview.json"), JSON.stringify(overview, null, 1) + "\n");
  writeFileSync(join(dir, "index.html"), await renderOverviewHtml(overview));
  fitCliInfo(`Overview of ${overview.sdks.length + overview.missing.length} SDKs, ${overview.dates[0] ?? "-"} to ${overview.dates.at(-1) ?? "-"}.`);
  return {};
}

if (isMain(import.meta.url)) {
  runCli(() => runOverviewCommand(process.argv.slice(2), "bun src/fit/health/report/overview-command.ts"));
}
