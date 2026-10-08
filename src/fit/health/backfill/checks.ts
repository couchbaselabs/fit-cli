#!/usr/bin/env node
/**
 * Checks that an SDK's backfilled records can be trusted - run at the end of every backfill,
 * and on their own:
 *
 *   bun src/fit/health/backfill/checks.ts <sdk> [--store <dir>] [--nights N]
 *
 *   1. identity   every run's performer tag names this SDK ("java:main" for java). A mismatch
 *                 means the opt-in lists a workflow that runs a different SDK.
 *   2. coverage   how many records come from full JUnit (the run archive) and how many only
 *                 from the CI log, which names at most 3 failures per Java package.
 *   3. agreement  for the most recent nights, the JUnit record and a fresh parse of the same
 *                 run's log name the same failing tests (the proof from Stage 1, per SDK) -
 *                 confirming the log parser reads this SDK's output correctly.
 *
 * Identity and agreement must pass; coverage is reported, since it depends on whether the
 * SDK's nightlies upload their run archives at all.
 */
import { gunzipSync } from "node:zlib";
import type { RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { compareRecords, type RecordComparison } from "../emit/compare-records.js";
import { buildRecords, parseRunLog } from "../log-parse/parse-run-log.js";
import { rawLogKey } from "../record/run-manifest.js";
import { recordKey, type RunRecord } from "../record/run-record.js";
import { type LocalHealthStore } from "../store/health-store.js";
import { openStore } from "../store/s3-store.js";
import { STORE_OPTION, parseHealthArgs } from "../cli-args.js";

export interface CheckReport {
  sdk: string;
  pass: boolean;
  /** From the stored raw logs, so it covers every run - including records rebuilt from JUnit. */
  identity: { runs: number; performers: Record<string, number>; mismatches: { run: string; performer: string }[] };
  coverage: { withResults: number; junit: number; logOnly: number; aborted: number; runs: number; runsWithArchive: number };
  agreement: RecordComparison[];
  /**
   * JUnit records a fresh parse of their run's log no longer produces at all: the parser has
   * lost a preset, so there is nothing to compare them with. Each one fails the check.
   */
  unmatched: string[];
}

/** The SDK half of a performer tag: "java:main" -> "java". */
export const performerSdk = (performer: string) => performer.slice(0, performer.indexOf(":"));

export function checkStore(store: LocalHealthStore, sdk: string, nights = 3): CheckReport {
  const manifests = store
    .listManifests(sdk)
    .sort((a, b) => b.date.localeCompare(a.date));
  const records = store.readRecords(sdk);

  const performers: Record<string, number> = {};
  const mismatches: { run: string; performer: string }[] = [];
  let runsChecked = 0;
  for (const m of manifests) {
    const raw = store.read(rawLogKey(sdk, m.runId, m.runAttempt));
    if (!raw) continue;
    runsChecked++;
    const seen = new Set(parseRunLog(gunzipSync(raw).toString("utf8")).runs.map((r) => r.performer).filter((p): p is string => !!p));
    for (const p of seen) {
      performers[p] = (performers[p] ?? 0) + 1;
      if (performerSdk(p) !== sdk) mismatches.push({ run: `${m.date} run ${m.runId}`, performer: p });
    }
  }
  const withResults = records.filter((r) => r.counts);
  const coverage = {
    withResults: withResults.length,
    junit: withResults.filter((r) => r.source !== "run-log-scrape").length,
    logOnly: withResults.filter((r) => r.source === "run-log-scrape").length,
    aborted: records.filter((r) => r.outcome === "aborted").length,
    runs: manifests.length,
    runsWithArchive: manifests.filter((m) => m.archive?.upgraded.length).length,
  };

  // Agreement: re-parse the stored log of the latest nights that have JUnit records.
  const agreement: RecordComparison[] = [];
  const unmatched: string[] = [];
  for (const m of manifests.filter((x) => x.archive?.upgraded.length).slice(0, nights)) {
    const raw = store.read(rawLogKey(sdk, m.runId, m.runAttempt));
    if (!raw) continue;
    const scraped = new Map(
      buildRecords(parseRunLog(gunzipSync(raw).toString("utf8")), { sdk, date: m.date, ci: m.ci ?? { repo: "unknown", runId: m.runId, runAttempt: m.runAttempt } }).records.map((r) => [recordKey(r), r]),
    );
    for (const key of m.archive!.upgraded) {
      const junit = JSON.parse(store.read(key)!.toString("utf8")) as RunRecord;
      const log = scraped.get(key);
      if (log) agreement.push(compareRecords(junit, log));
      else unmatched.push(`${m.date} ${junit.preset} ${junit.kind}${junit.cluster ? ` @${junit.cluster}` : ""}`);
    }
  }

  const identity = { runs: runsChecked, performers, mismatches };
  return { sdk, pass: mismatches.length === 0 && unmatched.length === 0 && agreement.every((a) => a.agree), identity, coverage, agreement, unmatched };
}

export function renderChecks(c: CheckReport): string {
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
  const lines = [
    `${c.pass ? "✓" : "✗"} ${c.sdk}: ${c.pass ? "checks pass" : "CHECKS FAIL"}`,
    `  identity   ${c.identity.mismatches.length === 0 ? "✓" : "✗"} ${c.identity.runs} run logs; performers seen: ${Object.entries(c.identity.performers).map(([p, n]) => `${p} (${n})`).join(", ") || "none"}`,
    ...c.identity.mismatches.slice(0, 5).map((m) => `             ✗ ${m.performer} in ${m.run} - this workflow runs another SDK`),
    `  coverage   ${c.coverage.junit}/${c.coverage.withResults} records with results from full JUnit (${pct(c.coverage.junit, c.coverage.withResults)}), ${c.coverage.logOnly} from the CI log only; ${c.coverage.runsWithArchive}/${c.coverage.runs} runs had a usable archive; ${c.coverage.aborted} aborted`,
    `  agreement  ${c.agreement.every((a) => a.agree) && !c.unmatched.length ? "✓" : "✗"} ${c.agreement.filter((a) => a.agree).length}/${c.agreement.length + c.unmatched.length} recent runs: JUnit and log name the same failures${c.agreement.some((a) => a.hiddenByCap.length) ? " (after failures hidden by fit-cli's 3-per-package cap)" : ""}`,
  ];
  for (const u of c.unmatched) lines.push(`             ✗ ${u}: has JUnit results, but the log parser no longer finds this run in its log`);
  for (const a of c.agreement.filter((x) => !x.agree)) {
    lines.push(`             ✗ ${a.label}`);
    if (a.onlyJunit.length) lines.push(`               failing in JUnit, not in the log: ${a.onlyJunit.slice(0, 5).join(", ")}`);
    if (a.onlyLog.length) lines.push(`               in the log, not failing in JUnit: ${a.onlyLog.slice(0, 5).join(", ")}`);
    if (a.classErrorsOnlyJunit.length) lines.push(`               classes errored in JUnit, not in the log: ${a.classErrorsOnlyJunit.slice(0, 5).join(", ")}`);
    if (a.classErrorsOnlyLog.length) lines.push(`               classes errored in the log, not in JUnit: ${a.classErrorsOnlyLog.slice(0, 5).join(", ")}`);
    if (!a.countsAgree) lines.push(`               counts: JUnit ${JSON.stringify(a.countsJunit)} vs log ${JSON.stringify(a.countsLog)}`);
  }
  return lines.join("\n");
}

export async function runChecksCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  const usage = `Check that an SDK's backfilled records can be trusted (identity, coverage, agreement).

Usage:
  ${prefix} <sdk> [--store <dir>] [--nights N]

  --nights  How many recent nights to cross-check JUnit against the log (default 3).`;
  const { values, sdk, help } = parseHealthArgs(argv, { ...STORE_OPTION, nights: { type: "string" } }, usage);
  if (help || argv.length === 0) {
    console.log(usage);
    return {};
  }
  if (!sdk) throw new Error(`Name an SDK.\n\n${usage}`);
  const nights = Number(values.nights ?? 3);
  if (!Number.isInteger(nights) || nights < 1) throw new Error(`--nights must be a whole number, at least 1; got ${values.nights}`);
  const { store, close } = await openStore(values.store ?? process.env.FIT_HEALTH_STORE, sdk);
  let c: CheckReport;
  try {
    c = checkStore(store, sdk, nights);
  } finally {
    close();
  }
  printWithoutTimestamps(renderChecks(c));
  if (!c.pass) process.exitCode = 1;
  return {};
}

if (isMain(import.meta.url)) {
  runCli(() => runChecksCommand(process.argv.slice(2), "bun src/fit/health/backfill/checks.ts"));
}
