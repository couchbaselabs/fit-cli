#!/usr/bin/env node
/**
 * Parse a whole GitHub Actions run log (`gh run view <id> --log`) into run records.
 *
 *   bun src/fit/health/log-parse/parse-run-log.ts <log file[.gz]> [--sdk dotnet] [--date 2026-09-27]
 *
 * Prints the records it would write, one per fit-cli run (preset × test type × cluster).
 *
 * This is the backfill path: fit-cli's log is the only record of a night that ran before
 * run records were emitted. It names only FAILING tests, so every record it produces has
 * passesKnown=false. Things that took a while to learn, all handled here:
 *   - Every log line is `job<TAB>step<TAB>message`, and ANSI colour codes arrive as the
 *     literal characters `^[`, not escape bytes.
 *   - A run is identified by the tag fit-cli prints on its lines,
 *     `[01:20:01·1/1·aws1·8.0-stable·dotnet:main·functional]`, not by the job name - the
 *     nightly went from one job to a job per preset on 2026-08-08.
 *   - Situational presets are NOT told apart by that tag: op-capella-sit-lite and
 *     op-capella-pe-sit-lite (private endpoint) both print `situational:standard-qe`. So each
 *     line is attributed to its preset: the job name when it carries one, else the last
 *     "=== Running preset N/M: <name> ===" banner in that job, else the preset the workflow
 *     invoked (a single-preset night prints no banner).
 *   - Failures are marked ❌ (assertion) or 💥 (errored/aborted - how transactions failures
 *     surface). Before ~2026-07-29 they were red two-space-indented names under "Failures:".
 *   - The results table gained an Err column at the same time.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { isMain } from "../../../util/non-fit/cli.js";
import {
  RUN_RECORD_SCHEMA,
  addOutcome,
  type CiContext,
  type ResultCounts,
  type RunRecord,
  type TestKind,
} from "../record/run-record.js";

/** Bump when a parser change could alter what an already-parsed log yields. */
export const LOG_PARSER_VERSION = "log-6";

/**
 * Before this date fit-cli printed a second copy of the functional summary under the
 * situational tag, so situational results from those nights are functional tests.
 */
export const SITUATIONAL_TRUSTED_FROM = "2026-07-11";

// eslint-disable-next-line no-control-regex
const ANSI = /(?:\x1b|\^\[)\[[0-9;]*m/g;
const TAG = /^\S+Z \[([^\]]*)\]\s*/;
const RAWTAG = /^\S+Z \[[^\]]*\] ?/;
const FAIL = /(❌|💥)\s+(\S+)/u;
// eslint-disable-next-line no-control-regex
const OLDFAIL = /^ {2}(?:\x1b|\^\[)\[31m(\S+)(?:\x1b|\^\[)\[0m\s*$/;
const ROW = /^(\S[\S ]*?)\s+\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|(?:\s*(\d+)\s*\|)?\s*([\d.]+)%\s*\|\s*([\d:.]+)\s*$/;
const VER = /^\d+\.\d/;
const RUNNING = /=== Running preset \d+\/\d+: (\S+) ===/;
const JOB_PRESET = /\/ (op-[\w-]+)$/;
const TOP_PRESET = /fit run preset "?([\w-]+)"?/;
const DEPLOYER = /--deployer=(\w+)/;
// fit-cli prints at most 3 failures per package, then this.
const HIDDEN = /\.\.\. and (\d+) more failure\(s\) in (\S+)/;
const PE_PARAM = /"enablePrivateEndpoint":\s*(true|false)/;
// fit-cli names the classification of a fatal error - "FitCliError/FatalToCluster: <why>" -
// and prints unclassified ones as a bare "FitCliError: <why>" (e.g. "ssh exited with code 255").
const FATAL = /FitCliError(?:\/(FatalTo\w+))?:\s*(.*)$/;
const UNCLASSIFIED = "Unclassified";
const SEVERITY = [UNCLASSIFIED, "FatalToRun", "FatalToSession", "FatalToCluster", "FatalToInstance", "FatalToAll"];

const SUITE_ALIAS: Record<string, string> = { func: "functional", "sit:standard-qe": "situational:standard-qe" };

/** The log format a line's failure markers and table use. */
export type LogFormat = "log-v1" | "log-v2";

export interface ParsedRun {
  preset: string;
  /** The raw suite from the tag, e.g. "functional", "functional:cng", "situational:standard-qe". */
  suite: string;
  kind: TestKind;
  cluster?: string;
  params: Record<string, string | number | boolean>;
  counts?: ResultCounts;
  /** Format of this run's table: v2 has an Err column. Undefined when no table was seen. */
  format?: LogFormat;
  failing: Set<string>;
  /** The names in `failing` marked only 💥 (errored), never ❌ (failed an assertion). */
  errored: Set<string>;
  /** "<sdk>:<image tag>" from the tag, e.g. "java:main". */
  performer?: string;
  /** Failures counted but not named, per package (fit-cli's per-package display cap). */
  hidden: Record<string, number>;
  job: string;
}

export interface PresetAbort {
  level: string;
  reason: string;
}

export interface ParsedLog {
  runs: ParsedRun[];
  /** The most severe fit-cli fatal error seen per preset. */
  aborts: Record<string, PresetAbort>;
  /** Presets named by banners or job names, whether or not they produced any tagged line. */
  presetsSeen: string[];
  sawAnyTag: boolean;
}

/** Strip the literal-or-real ANSI colour codes gh leaves in the log. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Parse the whole-run log text into one accumulator per fit-cli run. */
export function parseRunLog(text: string): ParsedLog {
  const runs = new Map<string, ParsedRun>();
  const curPreset = new Map<string, string>();
  const topPreset = new Map<string, string>();
  const params = new Map<string, Record<string, string | number | boolean>>();
  const presetsSeen = new Set<string>();
  const aborts: Record<string, PresetAbort> = {};
  let sawAnyTag = false;

  const paramsFor = (preset: string) => {
    let p = params.get(preset);
    if (!p) params.set(preset, (p = {}));
    return p;
  };

  for (const line of text.split("\n")) {
    const parts = line.replace(/\r$/, "").split("\t");
    if (parts.length < 3) continue;
    const job = parts[0];
    const rawMsg = parts.slice(2).join("\t");
    const msg = stripAnsi(rawMsg);

    const jobPreset = JOB_PRESET.exec(job)?.[1];
    if (jobPreset) presetsSeen.add(jobPreset);
    const banner = RUNNING.exec(msg)?.[1];
    if (banner) {
      curPreset.set(job, banner);
      presetsSeen.add(banner);
    }
    const top = TOP_PRESET.exec(msg)?.[1];
    if (top && !topPreset.has(job)) topPreset.set(job, top);
    const preset = jobPreset ?? curPreset.get(job) ?? topPreset.get(job);

    if (preset) {
      const dm = DEPLOYER.exec(msg);
      if (dm) paramsFor(preset).deployer = dm[1];
      const pm = PE_PARAM.exec(msg);
      if (pm) paramsFor(preset).privateEndpoint = pm[1] === "true";
      const fe = FATAL.exec(msg);
      const level = fe ? (fe[1] ?? UNCLASSIFIED) : undefined;
      // The most severe wins; among equals the last, since earlier ones are often retried.
      if (fe && level && SEVERITY.indexOf(level) >= SEVERITY.indexOf(aborts[preset]?.level ?? "")) {
        aborts[preset] = { level, reason: fe[2].trim().slice(0, 300) };
      }
    }

    const m = TAG.exec(msg);
    if (!m) continue;
    const fields = m[1].split("·").slice(1); // drop the leading timestamp
    if (fields.length === 0) continue;
    const suite = SUITE_ALIAS[fields[fields.length - 1]] ?? fields[fields.length - 1];
    const kind: TestKind | undefined = suite.startsWith("functional")
      ? "functional"
      : suite.startsWith("situational")
        ? "situational"
        : undefined;
    if (!kind) continue;
    sawAnyTag = true;
    if (!preset) continue; // never guess which preset a line belongs to

    const version = fields.find((f) => VER.test(f));
    // A deployment is the capitalised `Capella:8.0` field; the lower-case `dotnet:main`
    // (performer) and `functional:cng` (suite) fields also contain a colon.
    const deployment = fields.find((f) => /^[A-Z][\w-]*:/.test(f));
    const cluster = version ?? deployment;
    // The performer is the lower-case "<sdk>:<image tag>" field; the suite is always last.
    const performer = fields.slice(0, -1).find((f) => /^[a-z][a-z0-9-]*:[\w.-]+$/.test(f));
    const key = `${preset}|${suite}|${cluster ?? ""}`;
    let run = runs.get(key);
    if (!run) {
      run = { preset, suite, kind, cluster, params: {}, failing: new Set(), errored: new Set(), hidden: {}, job };
      runs.set(key, run);
    }
    if (performer && !run.performer) run.performer = performer;

    const body = msg.replace(TAG, "").trimEnd();
    const fm = FAIL.exec(msg);
    if (fm) {
      // A test named under both markers (say, once per API) counts as failed, not errored.
      if (fm[1] === "💥" && !run.failing.has(fm[2])) run.errored.add(fm[2]);
      if (fm[1] === "❌") run.errored.delete(fm[2]);
      run.failing.add(fm[2]);
    }
    const om = OLDFAIL.exec(rawMsg.replace(RAWTAG, "").trimEnd());
    if (om) {
      run.errored.delete(om[1]);
      run.failing.add(om[1]);
    }
    const hm = HIDDEN.exec(body);
    if (hm) run.hidden[hm[2]] = (run.hidden[hm[2]] ?? 0) + Number(hm[1]);
    const rm = ROW.exec(body);
    if (rm && rm[1] === "TOTAL") {
      run.counts = {
        passed: Number(rm[2]),
        skipped: Number(rm[3]),
        failed: Number(rm[4]),
        errored: Number(rm[5] ?? 0),
      };
      run.format = rm[5] === undefined ? "log-v1" : "log-v2";
    }
  }

  // A single-preset night (e.g. qe-set) prints no banner and has no preset in its job name, so
  // the preset it invoked is the only one it ran - it counts as seen, so that a night which
  // died before any tagged line is an honest abort (or a parse error), not a silent empty parse.
  // A job with banners or a preset job name invoked a group (op-multi-lite), not a preset.
  for (const [job, top] of topPreset) {
    if (!curPreset.has(job) && !JOB_PRESET.test(job)) presetsSeen.add(top);
  }

  for (const run of runs.values()) {
    run.params = { ...(params.get(run.preset) ?? {}) };
    // enablePrivateEndpoint is printed in the situational run's configuration; a multi-run
    // preset (qe-set) would otherwise stamp it on its functional runs too.
    if (run.kind !== "situational") delete run.params.privateEndpoint;
    if (run.suite.includes(":cng")) run.params.gateway = "cng";
  }
  return { runs: [...runs.values()], aborts, presetsSeen: [...presetsSeen].sort(), sawAnyTag };
}

export interface RecordBuildResult {
  records: RunRecord[];
  /** Runs skipped or doubted, with why. A non-empty list does not fail the whole log. */
  warnings: string[];
  /** Set when the log as a whole could not be read. */
  parseError?: string;
}

/**
 * Turn a parsed log into run records, applying the sanity checks that stop a bad parse from
 * reading as a healthy night: a run with counted failures must name some, and a run naming
 * failures must count some. A run failing either check is dropped with a warning rather
 * than stored - a stored record would be believed.
 */
export function buildRecords(parsed: ParsedLog, ctx: { sdk: string; date: string; ci: CiContext }): RecordBuildResult {
  const warnings: string[] = [];
  const records: RunRecord[] = [];
  const base = (preset: string, kind: TestKind) => ({
    schema: RUN_RECORD_SCHEMA,
    source: "run-log-scrape" as const,
    parserVersion: LOG_PARSER_VERSION,
    sdk: ctx.sdk,
    preset,
    kind,
    date: ctx.date,
    passesKnown: false,
  });

  // A preset that died before any of its runs printed a tagged line. With fit-cli's own
  // fatal-error line it is an honest "aborted" - a gap, never a pass. Without one we cannot
  // tell a harness death from a log format we don't recognise, so the log is a parse error.
  // A log naming no preset at all is a format we don't recognise, or a workflow that died
  // before fit-cli started. Either way it is not a night with nothing to report.
  if (parsed.presetsSeen.length === 0 && parsed.runs.length === 0) {
    return { records: [], warnings, parseError: "no FIT presets or result lines were recognised in the log" };
  }
  const presetsWithRuns = new Set(parsed.runs.map((r) => r.preset));
  const silent = parsed.presetsSeen.filter((p) => !presetsWithRuns.has(p));
  const unexplained = silent.filter((p) => !parsed.aborts[p]);
  if (unexplained.length > 0 && unexplained.length === parsed.presetsSeen.length) {
    return { records: [], warnings, parseError: `presets ran (${unexplained.join(", ")}) but no fit-cli result lines or fatal errors were recognised` };
  }
  for (const preset of silent) {
    const abort = parsed.aborts[preset];
    const kind = presetKind(preset);
    if (!abort || !kind) {
      warnings.push(`${preset}: produced no result lines${abort ? "" : " and no fatal error"} - not stored`);
      continue;
    }
    records.push({
      ...base(preset, kind),
      params: {},
      ci: { ...ctx.ci },
      outcome: "aborted",
      abortedAt: abort.level,
      abortReason: abort.reason,
      tests: {},
    });
  }

  for (const run of parsed.runs) {
    const label = `${run.preset} ${run.suite}${run.cluster ? ` @${run.cluster}` : ""}`;
    if (run.kind === "situational" && ctx.date < SITUATIONAL_TRUSTED_FROM) {
      warnings.push(`${label}: skipped, situational results before ${SITUATIONAL_TRUSTED_FROM} are functional tests printed under the situational tag`);
      continue;
    }
    const named = [...run.failing];
    const c = run.counts;
    if (c && c.failed + c.errored > 0 && named.length === 0) {
      warnings.push(`${label}: the table counts ${c.failed + c.errored} failures but none are named - not stored`);
      continue;
    }
    if (!c && named.length > 0) {
      // Before 2026-07-11 a functional table could be printed under the situational tag,
      // leaving the functional run with names but no table. It ran; it did not abort.
      warnings.push(`${label}: ${named.length} failures named but no results table - not stored`);
      continue;
    }
    if (c && c.failed + c.errored === 0 && named.length > 0) {
      warnings.push(`${label}: ${named.length} failures named but the table counts none - not stored`);
      continue;
    }
    const tests = {};
    for (const n of named) addOutcome(tests, n, run.errored.has(n) ? "e" : "f");
    const abort = !c ? parsed.aborts[run.preset] : undefined;
    records.push({
      ...base(run.preset, run.kind),
      ...(run.performer ? { performer: run.performer } : {}),
      cluster: run.cluster,
      ...(abort ? { abortedAt: abort.level, abortReason: abort.reason } : {}),
      params: { suite: run.suite, ...run.params },
      ci: { ...ctx.ci, job: run.job },
      outcome: !c ? "aborted" : c.failed + c.errored > 0 ? "tests_failed" : "passed",
      counts: c,
      ...(Object.keys(run.hidden).length ? { hiddenFailures: run.hidden } : {}),
      tests,
    });
  }
  return { records, warnings };
}

/** The test kind a preset runs, from its name (op-cng-sit-lite, op-onprem-func-lite). */
export function presetKind(preset: string): TestKind | undefined {
  if (/-sit(-|$)/.test(preset)) return "situational";
  if (/-func(-|$)/.test(preset)) return "functional";
  return undefined;
}

/** Read a log file, gunzipping when it ends in .gz. */
export function readLogFile(path: string): string {
  const buf = readFileSync(path);
  return path.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`Parse a GitHub Actions run log into fit health run records (prints them; writes nothing).

Usage:
  bun src/fit/health/log-parse/parse-run-log.ts <log file[.gz]> [--sdk <sdk>] [--date YYYY-MM-DD]

  --sdk    SDK the log belongs to (default: dotnet)
  --date   UTC date of the run (default: today). Situational results before
           ${SITUATIONAL_TRUSTED_FROM} are skipped, so the date matters.`);
    process.exit(0);
  }
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const file = args[0];
  const result = buildRecords(parseRunLog(readLogFile(file)), {
    sdk: opt("sdk") ?? "dotnet",
    date: opt("date") ?? new Date().toISOString().slice(0, 10),
    ci: { repo: "unknown", runId: 0, runAttempt: 1 },
  });
  console.log(JSON.stringify(result, null, 1));
}
