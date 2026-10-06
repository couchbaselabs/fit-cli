#!/usr/bin/env node
/**
 * fit health - which FIT tests fail consistently, which are intermittent, and which way
 * each SDK's nightly is trending.
 *
 *   fit health report <sdk>                       the health report (terminal, JSON, HTML)
 *   fit health backfill <sdk>                     fill in records for nightly runs GitHub still holds
 *   fit health import-logs <sdk> --dir --runs      import run logs already on disk
 *   fit health reparse <sdk>                      rebuild records from stored logs after a parser change
 *
 * Records live in a local store (~/.fit-cli/health) for now.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { runBackfillCommand } from "./backfill/backfill.js";
import { runChecksCommand } from "./backfill/checks.js";
import { runImportLogsCommand } from "./backfill/import-logs.js";
import { runReparseCommand } from "./backfill/reparse.js";
import { runReportCommand } from "./report/report.js";
import { runNotesCommand } from "./report/notes.js";
import { runSettingsCommand } from "./report/settings.js";
import { runCrossCommand } from "./report/cross-command.js";
import { runOverviewCommand } from "./report/overview-command.js";
import { HEALTH_OPT_INS } from "./registry/health-opt-ins.js";

function helpText(): string {
  const p = runScriptPrefix("health");
  return `Which FIT tests fail consistently, which are intermittent, and which way each SDK is trending.

Usage:
  ${p} opt-ins [--json]
  ${p} report <sdk> [--end YYYY-MM-DD] [--store <dir>] [--notes <file>]
  ${p} backfill <sdk> [--limit N] [--store <dir>] [--dry-run]
  ${p} import-logs <sdk> --dir <logs dir> --runs <runs.json> [--store <dir>]
  ${p} notes <sdk> [--set <file>] [--store <dir>]
  ${p} settings <sdk> [--slack-channel <id> | --no-slack] [--report-url <url>] [--store <dir>]
  ${p} cross --dir <reports>
  ${p} overview --dir <site>/health
  ${p} check <sdk> [--store <dir>] [--nights N]
  ${p} reparse <sdk> [--all] [--store <dir>]
  ${p} --help

Subcommands:
  opt-ins       List the SDKs committed as opted in (what the scheduled health workflow runs).
  report        Which tests fail consistently or intermittently, what started or stopped
                failing, and the trend. Prints a summary; writes JSON and HTML artifacts.
  backfill      Fetch and parse the nightly run logs GitHub still holds (the last 90 days)
                for an opted-in SDK. Safe to rerun: only missing runs are fetched.
  import-logs   Import whole-run logs already on disk, e.g. an archive older than 90 days.
  notes         Show or set an SDK's hand-written report notes (known fixes), kept in the store.
  settings      Show or set where an SDK's output goes (its Slack channel), kept in the store.
  cross         Compare every SDK's report from one run: the same test on the other SDKs.
  overview      Write the health site's top page: each SDK's last 30 nights, one chart each.
  check         Check an SDK's records can be trusted: runs name the right SDK, how much
                comes from full JUnit, and JUnit agrees with the log on recent nights.
                Backfill runs this at the end.
  reparse       Rebuild records from the stored raw logs after a parser change.

Opt an SDK in by adding it to src/fit/health/registry/health-opt-ins.ts. To try an opt-in
first, put the entry in a JSON5 file and set FIT_HEALTH_OPT_INS to it, with FIT_HEALTH_STORE
pointing at a scratch store.`;
}

export function runHealthMain(): void {
  const [sub, ...rest] = process.argv.slice(2);
  const p = runScriptPrefix("health");
  switch (sub) {
    case "opt-ins": {
      // The committed opt-ins only (never a local FIT_HEALTH_OPT_INS file): what CI iterates over.
      const sdks = Object.keys(HEALTH_OPT_INS).sort();
      console.log(rest.includes("--json") ? JSON.stringify(sdks) : sdks.join("\n"));
      return;
    }
    case "notes":
      runCli(() => runNotesCommand(rest, `${p} notes`));
      return;
    case "settings":
      runCli(() => runSettingsCommand(rest, `${p} settings`));
      return;
    case "cross":
      runCli(() => runCrossCommand(rest, `${p} cross`));
      return;
    case "overview":
      runCli(() => runOverviewCommand(rest, `${p} overview`));
      return;
    case "report":
      runCli(() => runReportCommand(rest, `${p} report`));
      return;
    case "backfill":
      runCli(() => runBackfillCommand(rest, `${p} backfill`));
      return;
    case "check":
      runCli(() => runChecksCommand(rest, `${p} check`));
      return;
    case "reparse":
      runCli(() => runReparseCommand(rest, `${p} reparse`));
      return;
    case "import-logs":
      runCli(() => runImportLogsCommand(rest, `${p} import-logs`));
      return;
    default:
      console.log(helpText());
      if (sub !== undefined && sub !== "--help" && sub !== "-h") process.exit(2);
  }
}

if (isMain(import.meta.url)) {
  runHealthMain();
}
