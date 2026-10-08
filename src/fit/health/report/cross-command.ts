#!/usr/bin/env node
/**
 * Compare every SDK's report from one run with every other's, and write the result back into
 * each: `crossSdk` on every finding in triage.json, and a line per finding on the page.
 *
 *   bun src/fit/health/report/cross-command.ts --dir <reports>
 *
 * <reports> holds one directory per SDK, as the health workflow downloads them:
 * health-report-<sdk>/ with health-report.json, triage.json and health-report.html.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliInfo } from "../../../util/non-fit/fit-cli-log.js";
import { sdkByValue } from "../../../util/sdk/sdks.js";
import { loadOptIns } from "../registry/health-opt-ins.js";
import type { HealthReport } from "./build-report.js";
import { crossCompare, summariseCross } from "./cross.js";
import { renderHtml } from "./render/render-html.js";
import type { TriageReport } from "./triage.js";
import { parseHealthArgs } from "../cli-args.js";

export function crossHelp(prefix: string): string {
  return `Compare every SDK's report from one run with every other's: the same test on the other SDKs.

Usage:
  ${prefix} --dir <reports>

<reports> holds health-report-<sdk>/ directories (health-report.json, triage.json and
health-report.html each), as the health workflow downloads them. Each SDK's triage.json gains
crossSdk on every finding, and its page a line saying where else the test fails.`;
}

export async function runCrossCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  const { values, help } = parseHealthArgs(argv, { dir: { type: "string" } }, crossHelp(prefix), 0);
  if (help) {
    console.log(crossHelp(prefix));
    return {};
  }
  const { dir } = values;
  if (!dir) throw new Error(crossHelp(prefix));
  const sdks = readdirSync(dir)
    .filter((d) => d.startsWith("health-report-") && existsSync(join(dir, d, "triage.json")))
    .map((d) => d.slice("health-report-".length))
    .sort();
  const triage = sdks.map((sdk) => JSON.parse(readFileSync(join(dir, `health-report-${sdk}`, "triage.json"), "utf8")) as TriageReport);
  const optIns = loadOptIns();
  const families = Object.fromEntries(sdks.map((sdk) => [sdk, optIns[sdk]?.family]));
  crossCompare(triage, families);
  for (const t of triage) {
    const sub = join(dir, `health-report-${t.sdk}`);
    writeFileSync(join(sub, "triage.json"), JSON.stringify(t, null, 1) + "\n");
    const reportPath = join(sub, "health-report.json");
    if (existsSync(reportPath)) {
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as HealthReport;
      report.cross = summariseCross(t);
      writeFileSync(reportPath, JSON.stringify(report, null, 1) + "\n");
      writeFileSync(join(sub, "health-report.html"), await renderHtml(report, sdkByValue(t.sdk)?.name ?? t.sdk));
    }
  }
  fitCliInfo(`Compared ${sdks.length} SDKs' reports: ${sdks.join(", ")}.`);
  return {};
}

if (isMain(import.meta.url)) {
  runCli(() => runCrossCommand(process.argv.slice(2), "bun src/fit/health/report/cross-command.ts"));
}
