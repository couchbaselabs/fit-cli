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
import { gunzipSync } from "node:zlib";
import { LOG_PARSER_VERSION } from "../log-parse/parse-run-log.js";
import { rawLogKey, type RunManifest } from "../record/run-manifest.js";
import type { RunRecord } from "../record/run-record.js";
import { defaultHealthStoreRoot } from "../store/health-store.js";
import { openStore } from "../store/s3-store.js";
import { ingestLog } from "./ingest-log.js";

export function reparseHelp(prefix: string): string {
  return `Rebuild run records from the raw logs in the store (no GitHub access needed).

Usage:
  ${prefix} <sdk> [--all] [--store <dir>]

  --all     Reparse every stored log, not only those parsed by an older parser (${LOG_PARSER_VERSION} is current).
  --store   Store: a directory, or s3://bucket/prefix/ (default: ${defaultHealthStoreRoot()}, or $FIT_HEALTH_STORE).`;
}

export async function runReparseCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(reparseHelp(prefix));
    return {};
  }
  const sdk = argv.find((a, i) => !a.startsWith("-") && argv[i - 1] !== "--store");
  if (!sdk) throw new Error(reparseHelp(prefix));
  const i = argv.indexOf("--store");
  const opened = await openStore(i >= 0 ? argv[i + 1] : process.env.FIT_HEALTH_STORE, sdk);
  const store = opened.store;
  const all = argv.includes("--all");

  let done = 0;
  let records = 0;
  let parseErrors = 0;
  try {
    for (const key of store.list(`${sdk}/manifests`)) {
      const m = JSON.parse(store.read(key)!.toString("utf8")) as RunManifest;
      if (m.status !== "ok" && m.status !== "parse_error") continue;
      if (!all && m.parserVersion === LOG_PARSER_VERSION) continue;
      const raw = store.read(rawLogKey(sdk, m.runId, m.runAttempt));
      if (!raw) continue; // an emitted-only run has no log to reparse
      // Older manifests don't carry the CI context; take it from one of their records.
      const fromRecord = m.records.map((k) => store.read(k)).find((b): b is Buffer => !!b);
      const ci = m.ci ?? (fromRecord ? (JSON.parse(fromRecord.toString("utf8")) as RunRecord).ci : undefined);
      const next = ingestLog(
        store,
        { sdk, date: m.date, ci: { repo: "unknown", ...ci, runId: m.runId, runAttempt: m.runAttempt } },
        gunzipSync(raw).toString("utf8"),
        { keepRaw: false },
      );
      done++;
      records += next.records.length;
      if (next.status === "parse_error") parseErrors++;
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
