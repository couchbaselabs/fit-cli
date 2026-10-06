#!/usr/bin/env node
/**
 * Import run logs that are already on disk - e.g. an archive collected before GitHub's
 * 90-day retention deleted the originals.
 *
 *   bun src/fit/health/backfill/import-logs.ts <sdk> --dir <logs dir> --runs <runs.json> [--store <dir>]
 *
 * <logs dir> holds `<runId>.log` or `<runId>.log.gz` whole-run logs (`gh run view <id> --log`).
 * <runs.json> is `gh run list --json databaseId,createdAt,event,headSha,headBranch,attempt`
 * output for the same workflow, which supplies each run's date and commit.
 *
 * Like backfill, it skips runs that already have a manifest, so it is safe to rerun.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliInfo } from "../../../util/non-fit/fit-cli-log.js";
import { LOG_PARSER_VERSION, readLogFile } from "../log-parse/parse-run-log.js";
import { needsWork } from "../record/run-manifest.js";
import { healthOptIn } from "../registry/health-opt-ins.js";
import { defaultHealthStoreRoot } from "../store/health-store.js";
import { openStore } from "../store/s3-store.js";
import { ingestLog } from "./ingest-log.js";

interface GhRunListEntry {
  databaseId: number;
  createdAt: string;
  event?: string;
  headSha?: string;
  headBranch?: string;
  attempt?: number;
  workflowName?: string;
}

export function importLogsHelp(prefix: string): string {
  return `Import whole-run logs already on disk into the fit health store.

Usage:
  ${prefix} <sdk> --dir <logs dir> --runs <runs.json> [--store <dir>]

  --dir     Directory of <runId>.log / <runId>.log.gz files.
  --runs    \`gh run list --json databaseId,createdAt,event,headSha,headBranch,attempt\` output.
  --store   Store: a directory, or s3://bucket/prefix/ (default: ${defaultHealthStoreRoot()}, or $FIT_HEALTH_STORE).

Only scheduled runs are imported. Runs already stored are skipped.`;
}

export async function runImportLogsCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(importLogsHelp(prefix));
    return {};
  }
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sdk = argv.find((a, i) => !a.startsWith("-") && !argv[i - 1]?.startsWith("--"));
  const dir = opt("dir");
  const runsFile = opt("runs");
  if (!sdk || !dir || !runsFile) throw new Error(`Name an SDK, --dir and --runs.\n\n${importLogsHelp(prefix)}`);
  const optIn = healthOptIn(sdk);
  const opened = await openStore(opt("store") ?? process.env.FIT_HEALTH_STORE, sdk);
  const store = opened.store;

  const runs = new Map<number, GhRunListEntry>(
    (JSON.parse(readFileSync(runsFile, "utf8")) as GhRunListEntry[]).map((r) => [r.databaseId, r]),
  );
  let imported = 0;
  let skipped = 0;
  let parseErrors = 0;
  let records = 0;
  try {
    for (const file of readdirSync(dir).sort()) {
      const m = /^(\d+)\.log(\.gz)?$/.exec(file);
      const run = m ? runs.get(Number(m[1])) : undefined;
      if (!run || (run.event && run.event !== "schedule")) continue;
      const attempt = run.attempt ?? 1;
      if (!needsWork(store.readManifest(sdk, run.databaseId, attempt), LOG_PARSER_VERSION)) {
        skipped++;
        continue;
      }
      const manifest = ingestLog(store, {
        sdk,
        date: run.createdAt.slice(0, 10),
        ci: {
          repo: optIn?.repo ?? "unknown",
          workflow: optIn?.workflows[0],
          ref: run.headBranch ? `refs/heads/${run.headBranch}` : undefined,
          sha: run.headSha,
          event: run.event,
          runId: run.databaseId,
          runAttempt: attempt,
        },
      }, readLogFile(join(dir, file)));
      imported++;
      records += manifest.records.length;
      if (manifest.status === "parse_error") parseErrors++;
    }
    await opened.flush();
  } finally {
    opened.close();
  }
  fitCliInfo(`Imported ${imported} run logs → ${records} records (${parseErrors} parse errors); ${skipped} already stored. Store: ${opened.location}`);
  return { details: [{ label: "Store", value: opened.location }], artifacts: [] };
}

if (isMain(import.meta.url)) {
  runCli(() => runImportLogsCommand(process.argv.slice(2), "bun src/fit/health/backfill/import-logs.ts"));
}
