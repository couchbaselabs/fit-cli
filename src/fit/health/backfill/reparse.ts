#!/usr/bin/env node
/**
 * Rebuild run records from the raw logs already in the store, after a parser change.
 *
 *   bun src/fit/health/backfill/reparse.ts <sdk> [--all] [--store <dir>]
 *
 * By default reparses every run whose manifest was written by a different parser version;
 * --all reparses every stored log. Needs nothing from GitHub - which is the point of keeping
 * the raw logs, since GitHub deletes them after 90 days.
 */
import type { RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliInfo } from "../../../util/non-fit/fit-cli-log.js";
import { LOG_PARSER_VERSION } from "../log-parse/parse-run-log.js";
import { defaultHealthStoreRoot } from "../store/health-store.js";
import { openStore } from "../store/s3-store.js";
import { ingestLog } from "./ingest-log.js";
import { STORE_OPTION, parseSdkCommandArgs } from "../cli-args.js";

export function reparseHelp(prefix: string): string {
  return `Rebuild run records from the raw logs in the store (no GitHub access needed).

Usage:
  ${prefix} <sdk> [--all] [--store <dir>]

  --all     Reparse every stored log, not only those parsed by an older parser (${LOG_PARSER_VERSION} is current).
  --store   Store: a directory, or s3://bucket/prefix/ (default: ${defaultHealthStoreRoot()}, or $FIT_HEALTH_STORE).`;
}

export async function runReparseCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  const args = parseSdkCommandArgs(argv, { ...STORE_OPTION, all: { type: "boolean" } }, reparseHelp(prefix));
  if (!args) return {};
  const { values, sdk } = args;
  const opened = await openStore(values.store, sdk);
  const store = opened.store;
  const all = values.all === true;

  let done = 0;
  let records = 0;
  let parseErrors = 0;
  try {
    for (const m of store.listManifests(sdk)) {
      if (m.status !== "ok" && m.status !== "parse_error") continue;
      if (!all && m.parserVersion === LOG_PARSER_VERSION) continue;
      const text = store.readRawLog(sdk, m.runId, m.runAttempt);
      if (text === undefined) continue; // no stored log to reparse
      const next = ingestLog(store, { sdk, date: m.date, ci: m.ci }, text, { keepRaw: false });
      done++;
      records += next.records.length;
      // A run kept as it was because the new parse lost part of it counts too: its status stays "ok".
      if (next.status === "parse_error" || next.reparseError?.parserVersion === LOG_PARSER_VERSION) parseErrors++;
    }
    fitCliInfo(`Reparsed ${done} run logs with ${LOG_PARSER_VERSION} → ${records} records (${parseErrors} parse errors).`);
    await opened.flush();
  } finally {
    opened.close();
  }
  return { details: [{ label: "Store", value: opened.location }], artifacts: [] };
}

if (isMain(import.meta.url)) {
  runCli(() => runReparseCommand(process.argv.slice(2), "bun src/fit/health/backfill/reparse.ts"));
}
