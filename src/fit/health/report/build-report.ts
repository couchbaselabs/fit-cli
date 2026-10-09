/**
 * Run records -> the health report: per series, every test that failed recently with its
 * night-by-night history and class, what changed in the last two weeks, and comparisons
 * between presets that differ only by a run parameter.
 *
 * The report is the one output: the HTML page renders exactly this, and it is the JSON a
 * triage agent reads (published as report.json, described in specs/health.md). It is derived
 * and disposable: change a rule in classify.ts and regenerate it.
 */
import type { ChangeAnalysis, DriverChanges, SdkChanges } from "./changes.js";
import type { CrossSdk } from "./cross.js";
import { buildDigest, type Digest } from "./digest.js";
import { sdkCommitOf, type RunManifest } from "../record/run-manifest.js";
import type { RunRecord } from "../record/run-record.js";
import {
  CLASS_BLURBS,
  CLASS_LABELS,
  CLASS_ORDER,
  WINDOW_DAYS,
  classify,
  isFailure,
  isKnown,
  type Classification,
  type NightOutcome,
  type TestClass,
} from "./classify.js";
import { buildSeries, testHistories, type Series } from "./series.js";
import { addDays, calendarDays, daysBetween } from "./dates.js";
import { SDKS } from "../../../util/sdk/sdks.js";


/** The "what changed" lists cover the last two weeks. */
export const RECENT_DAYS = 14;
/** How far back a report looks, in calendar days ending at its end date. The store keeps everything. */
export const HISTORY_DAYS = 90;

/**
 * Hand-written context that the data can't supply: known fixes. A report covers its own SDK
 * only - it makes no claim about other SDKs (see the plan: cross-SDK correlation will consume
 * other SDKs' published reports, later).
 */
export interface ReportNotes {
  fixes?: Record<string, { ticket?: string; text: string }>;
}

export interface ReportTest extends Classification {
  /** Exact test id: "Class.method", or "Class" for a whole class that errored. */
  test: string;
  /** One NightOutcome (p/f/e/u/n) per night the series ran, aligned with the series' `ran`. */
  seq: string;
  runs: number;
  fails: number;
  /**
   * The current failure run began on the series' first night with results, so when the test
   * started failing isn't known: it was failing when the history begins. Such a test is not
   * listed as having started failing.
   */
  sinceFirstNight?: boolean;
  /** A known fix, from the SDK's notes (fit health notes). */
  fix?: { ticket?: string; text: string };
  /**
   * What changed between the baseline night (`lastGood`, else `previousNight`) and the first
   * night of `lastEpisode`, in the SDK and in the FIT driver, and the likely cause (see
   * changes.ts). Absent until looked up, and for a test with no such pair of nights.
   */
  sdkChange?: SdkChanges;
  driverChanges?: DriverChanges;
  changeAnalysis?: ChangeAnalysis;
  /** The same test on every other SDK with a report (see cross.ts). Absent until compared. */
  crossSdk?: CrossSdk;
}

/**
 * One night a series ran: the CI run, and the SDK commit it tested. The run's page is
 * `https://github.com/<repo>/actions/runs/<runId>/attempts/<attempt>`, with the report's
 * `repo` unless the night names another.
 */
export interface ReportNight {
  repo?: string;
  runId: number;
  attempt: number;
  job?: string;
  /**
   * The SDK commit under test: the performer image's revision when the log shows it (then
   * `sdkCommitFrom: "performer-image"`), else the commit the nightly workflow checked out.
   */
  sdkCommit?: string;
  sdkCommitFrom?: "performer-image" | "workflow";
  /** The commit the workflow checked out, when it differs from `sdkCommit`. */
  workflowCommit?: string;
  /** The S3 run archive and the surefire tarball in it, when the record came from JUnit. */
  archive?: { uri: string; member: string };
  /** "run-archive-junit": every outcome is known; "run-log-scrape": only failures are named. */
  source: RunRecord["source"];
}

/**
 * One night of one series, counted in tests - the Class.method you'd go and fix - not test
 * cases: one test can run as many cases (each API, every permutation; one permutation test runs
 * 1,000), and fit-cli's results table counts those. A night read only from the CI log names its
 * failures but not its passes, so it has `testCases` and `failing` but no test totals.
 */
export interface NightTests {
  /** Test cases, as in fit-cli's results table. */
  testCases: number;
  /** Distinct tests, when the night came from full JUnit: passed + failing + skipped. */
  tests?: number;
  passed?: number;
  failing: number;
  skipped?: number;
}

export function nightTests(record: RunRecord): NightTests {
  const c = record.counts!;
  const testCases = c.passed + c.failed + c.errored + c.skipped;
  let passed = 0;
  let failing = 0;
  let skipped = 0;
  for (const o of Object.values(record.tests)) {
    passed += o.p?.length ?? 0;
    failing += (o.f?.length ?? 0) + (o.e?.length ?? 0) + (o.classError ? 1 : 0);
    skipped += o.s?.length ?? 0;
  }
  return record.passesKnown ? { testCases, tests: passed + failing + skipped, passed, failing, skipped } : { testCases, failing };
}

export interface ReportSeries {
  id: string;
  label: string;
  short: string;
  preset: string;
  kind: RunRecord["kind"];
  params: Record<string, string | number | boolean>;
  /** Distinct clusters in date order, e.g. ["8.0-stable", "8.5-stable"]. */
  clusters: { cluster: string; from: string; to: string }[];
  passesKnown: boolean;
  ran: string[];
  aborted: Series["aborted"];
  degraded: string[];
  /** Each night in `ran`: its CI run and SDK commit. */
  nights: Record<string, ReportNight>;
  /** Distinct failing tests per night; null on a degraded night, where a count would mislead. */
  perNight: Record<string, number | null>;
  /** Per night: how many tests ran, and how they did (see NightTests). */
  testCounts: Record<string, NightTests>;
  /**
   * The latest night's counts. `usable`: it is the report's end date and wasn't degraded or
   * truncated - only those nights add up into "last night".
   */
  latest?: NightTests & { date: string; usable: boolean };
  counts: Record<TestClass, number>;
  tests: ReportTest[];
  started: { test: string; since: string; nights: number }[];
  stopped: { test: string; last: string; run: number; clean: number; fix?: { ticket?: string; text: string } }[];
  /** Tests that stopped running in the last RECENT_DAYS days, after failing in the window. */
  stoppedRunning: { test: string; lastRan: string; lastResult: "p" | "f" | "e"; since: string }[];
  /** Tests that stopped running longer ago than that: left out of `tests` altogether. */
  stoppedRunningEarlier: number;
  /** False when the series last ran before the window: shown, but kept out of the headline. */
  active: boolean;
}

export interface ParamComparison {
  a: string;
  b: string;
  param: string;
  nights: number;
  first?: string;
  aRed: number;
  bRed: number;
  bothRed: number;
  rows: { test: string; a: { f: number; n: number }; b: { f: number; n: number } }[];
}

export interface HealthReport {
  sdk: string;
  /** The SDK repo the nightly runs are in (the latest night's), for run and commit links. */
  repo?: string;
  generatedAt: string;
  start: string;
  end: string;
  dates: string[];
  /** Nights with no functional results at all (every functional run aborted or missing). */
  blackout: string[];
  /**
   * `windowDays`: the days a test is classified over. `recentDays`: how far back "started" and
   * "stopped failing" (and "stopped running") look.
   */
  classes: { order: readonly TestClass[]; labels: Record<TestClass, string>; blurbs: Record<TestClass, string>; windowDays: number; recentDays: number };
  /** Every SDK's display name by its value ("dotnet" -> ".NET"), for naming other SDKs. */
  sdkNames: Record<string, string>;
  series: ReportSeries[];
  comparisons: ParamComparison[];
  /**
   * Per test type: every test with a known result (passed, failed or errored) in the
   * classification window - what another SDK's report needs to say "this SDK runs that test",
   * not just "it fails it". A night read only from the CI log names failures, not passes, so
   * `complete` says whether every night came from full JUnit.
   */
  testsSeen: Record<RunRecord["kind"], { tests: string[]; complete: boolean }>;
  source: { records: number; scraped: number; archive: number; unreadableRuns: { date: string; runId: number; status: string; reason?: string }[] };
  /** What every view leads with, built once from the series (digest.ts). */
  digest: Digest;
}

const PRESET_ORDER = ["op-onprem-func", "op-cng-func", "op-capella-func", "op-capella-sit", "op-capella-pe-sit", "op-cng-sit"];

/** Where a preset runs, for labels: "on-prem", "CNG", "Capella · private endpoint". */
export function presetWhere(preset: string, params: Record<string, unknown>): string {
  if (/^op-capella-pe-/.test(preset) || params.privateEndpoint === true) return "Capella · private endpoint";
  if (/^op-capella-/.test(preset)) return "Capella · public endpoint";
  if (/^op-cng-/.test(preset) || params.gateway === "cng") return "CNG";
  if (/^op-onprem-/.test(preset)) return "on-prem";
  return `${preset} preset`;
}

type Manifests = ReadonlyMap<string, RunManifest>;

function reportNight(r: RunRecord, manifest: RunManifest | undefined, repo: string | undefined): ReportNight {
  const sdk = sdkCommitOf(r, manifest);
  return {
    ...(r.ci.repo !== repo ? { repo: r.ci.repo } : {}),
    runId: r.ci.runId,
    attempt: r.ci.runAttempt,
    ...(r.ci.job ? { job: r.ci.job } : {}),
    ...(sdk.sha ? { sdkCommit: sdk.sha, sdkCommitFrom: sdk.fromImage ? ("performer-image" as const) : ("workflow" as const) } : {}),
    ...(sdk.fromImage && r.ci.sha && r.ci.sha !== sdk.sha ? { workflowCommit: r.ci.sha } : {}),
    ...(r.archive ? { archive: r.archive } : {}),
    source: r.source,
  };
}

function reportSeries(s: Series, end: string, notes: ReportNotes, manifests: Manifests, repo: string | undefined): ReportSeries {
  const histories = testHistories(s);
  const degraded = new Set(s.degraded);
  const tests: ReportTest[] = [];
  let stoppedRunningEarlier = 0;
  // Per-night failure counts take every history, including tests no longer followed below:
  // they failed on those nights, and the chart and night panel count them.
  const everySeq: string[] = [];
  for (const [test, seq] of histories) {
    everySeq.push(seq.join(""));
    const c = classify(s.ran, seq, end);
    // A test that stopped running is reported for RECENT_DAYS, then no longer followed.
    if (c.cls === "stopped" && daysBetween(c.notRunSince!, end) >= RECENT_DAYS) {
      stoppedRunningEarlier++;
      continue;
    }
    const fix = notes.fixes?.[test];
    tests.push({
      test,
      seq: seq.join(""),
      runs: seq.filter(isKnown).length,
      fails: seq.filter(isFailure).length,
      ...c,
      ...(c.since && c.since === s.ran[0] ? { sinceFirstNight: true } : {}),
      ...(fix ? { fix } : {}),
    });
  }
  const order = (c: TestClass) => CLASS_ORDER.indexOf(c);
  tests.sort((a, b) => order(a.cls) - order(b.cls) || b.fails / b.runs - a.fails / a.runs || a.test.localeCompare(b.test));

  const counts = Object.fromEntries(CLASS_ORDER.map((c) => [c, tests.filter((t) => t.cls === c).length])) as Record<TestClass, number>;
  const perNight: Record<string, number | null> = {};
  for (const d of s.ran) perNight[d] = degraded.has(d) ? null : 0;
  for (const seq of everySeq) {
    [...seq].forEach((x, i) => {
      const n = perNight[s.ran[i]];
      if (isFailure(x) && n !== null) perNight[s.ran[i]] = n + 1;
    });
  }
  const testCounts: Record<string, NightTests> = {};
  const nights: Record<string, ReportNight> = {};
  for (const n of s.nights) {
    testCounts[n.date] = nightTests(n.record);
    nights[n.date] = reportNight(n.record, manifests.get(`${n.record.ci.runId}-${n.record.ci.runAttempt}`), repo);
  }
  const lastNight = s.ran.at(-1);

  const clusters: ReportSeries["clusters"] = [];
  for (const [d, cl] of Object.entries(s.clusters).sort(([a], [b]) => a.localeCompare(b))) {
    if (!cl) continue;
    const last = clusters.at(-1);
    if (last && last.cluster === cl) last.to = d;
    else clusters.push({ cluster: cl, from: d, to: d });
  }

  const where = presetWhere(s.preset, s.params);
  const kind = s.kind === "functional" ? "Functional" : "Situational";
  const multiCluster = s.id.split("|").length > 2;
  const lastRan = s.ran.at(-1) ?? s.aborted.at(-1)?.date;
  return {
    id: s.id,
    label: `${kind} · ${where}${s.variant ? ` · ${s.variant}` : ""}${multiCluster && clusters[0] ? ` (${clusters[0].cluster})` : ""}`,
    short: where,
    preset: s.preset,
    kind: s.kind,
    params: s.params,
    clusters,
    passesKnown: s.passesKnown,
    ran: s.ran,
    aborted: s.aborted,
    degraded: s.degraded,
    nights,
    perNight,
    testCounts,
    ...(lastNight ? { latest: { date: lastNight, ...testCounts[lastNight], usable: lastNight === end && !s.degraded.includes(lastNight) } } : {}),
    counts,
    tests,
    started: tests
      .filter((t) => t.cls === "failing" && t.streak && t.since && !t.sinceFirstNight && daysBetween(t.since, end) < RECENT_DAYS)
      .map((t) => ({ test: t.test, since: t.since!, nights: t.streak })),
    stopped: tests
      .filter((t) => t.cls === "recovered" && t.lastFail && daysBetween(t.lastFail, end) < RECENT_DAYS)
      .map((t) => ({ test: t.test, last: t.lastFail!, run: t.lastEpisode!.nights, clean: t.cleanTail, fix: t.fix })),
    stoppedRunning: tests
      .filter((t) => t.cls === "stopped")
      .map((t) => ({ test: t.test, lastRan: t.lastRan!, lastResult: t.lastResult!, since: t.notRunSince! })),
    stoppedRunningEarlier,
    active: !!lastRan && daysBetween(lastRan, end) < WINDOW_DAYS,
  };
}

/**
 * Pairs of series that are the same preset family and test type but differ in exactly one
 * run parameter - the private-endpoint and public Capella presets, today. Compared over the
 * nights both ran, so neither is judged on nights the other didn't have.
 *
 * A row covers every test that failed in either preset. For a test that never failed in one
 * of them, `historyOf` gives that preset's night-by-night outcomes from its records - so a
 * scenario one preset didn't run counts as not run there, never as passing.
 */
export function paramComparisons(series: ReportSeries[], historyOf: (seriesId: string, test: string) => string | undefined): ParamComparison[] {
  const out: ParamComparison[] = [];
  for (const [i, a] of series.entries()) {
    for (const b of series.slice(i + 1)) {
      if (a.kind !== b.kind || !a.active || !b.active) continue;
      const keys = new Set([...Object.keys(a.params), ...Object.keys(b.params)].filter((k) => k !== "deployer"));
      const differing = [...keys].filter((k) => a.params[k] !== b.params[k]);
      if (differing.length !== 1) continue;
      const aClusters = a.clusters.map((c) => c.cluster).join();
      if (aClusters !== b.clusters.map((c) => c.cluster).join()) continue;
      const [first, second] = a.params[differing[0]] ? [b, a] : [a, b];
      // Only nights both ran AND both have a usable total: an unusable night is a gap, not a pass.
      const common = first.ran.filter((d) => second.ran.includes(d) && first.perNight[d] !== null && second.perNight[d] !== null);
      const rate = (s: ReportSeries, test: string) => {
        const history = s.tests.find((x) => x.test === test)?.seq ?? historyOf(s.id, test) ?? "";
        const seq = new Map(s.ran.map((d, k) => [d, history[k]]));
        const known = common.map((d) => seq.get(d)).filter((x): x is NightOutcome => !!x && isKnown(x));
        return { f: known.filter(isFailure).length, n: known.length };
      };
      const tests = [...new Set([...first.tests, ...second.tests].map((t) => t.test))].sort();
      out.push({
        a: first.id,
        b: second.id,
        param: differing[0],
        nights: common.length,
        first: common[0],
        aRed: common.filter((d) => first.perNight[d]! > 0).length,
        bRed: common.filter((d) => second.perNight[d]! > 0).length,
        bothRed: common.filter((d) => first.perNight[d]! > 0 && second.perNight[d]! > 0).length,
        rows: tests.map((t) => ({ test: t, a: rate(first, t), b: rate(second, t) })),
      });
    }
  }
  return out;
}

export function buildHealthReport(
  sdk: string,
  records: RunRecord[],
  manifests: RunManifest[],
  opts: { end?: string; days?: number; notes?: ReportNotes; now?: Date } = {},
): HealthReport {
  const allDates = [...new Set([...records.map((r) => r.date), ...manifests.map((m) => m.date)])].sort();
  const end = opts.end ?? allDates.at(-1) ?? new Date().toISOString().slice(0, 10);
  // The report looks at the last `days` calendar days only - the strips, chart, "overall"
  // counts and the folded list alike - so it stays the same size however long the store's
  // history grows. Every day in that span is in the calendar: a night the nightly didn't run
  // at all is a gap in the report (and a blackout night), never silently skipped.
  const days = opts.days ?? HISTORY_DAYS;
  const windowStart = addDays(end, -(days - 1));
  const first = allDates.find((d) => d >= windowStart);
  const dates = calendarDays(first, end);
  const inRange = records.filter((r) => r.date >= windowStart && r.date <= end);
  const manifestsInRange = manifests.filter((m) => m.date >= windowStart && m.date <= end);
  const notes = opts.notes ?? {};

  const rank = (s: ReportSeries) => {
    const i = PRESET_ORDER.findIndex((p) => s.preset.startsWith(p));
    return (s.kind === "functional" ? 0 : 100) + (i < 0 ? 50 : i);
  };
  const built = buildSeries(inRange);
  const builtById = new Map(built.map((s) => [s.id, s]));
  const historyOf = (id: string, test: string) => {
    const s = builtById.get(id);
    return s && testHistories(s, { include: [test] }).get(test)?.join("");
  };
  const manifestOf: Manifests = new Map(manifests.map((m) => [`${m.runId}-${m.runAttempt}`, m]));
  const repo = inRange.at(-1)?.ci.repo;
  const series = built
    .map((s) => reportSeries(s, end, notes, manifestOf, repo))
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const functional = series.filter((s) => s.kind === "functional");
  // No usable functional results from any preset: none ran, or every one that did was
  // degraded or truncated that night (perNight is null for those).
  const blackout = dates.filter((d) => !functional.some((s) => d in s.perNight && s.perNight[d] !== null));

  const report: Omit<HealthReport, "digest"> = {
    sdk,
    ...(repo ? { repo } : {}),
    generatedAt: (opts.now ?? new Date()).toISOString(),
    start: dates[0] ?? end,
    end,
    dates,
    blackout,
    classes: { order: CLASS_ORDER, labels: CLASS_LABELS, blurbs: CLASS_BLURBS, windowDays: WINDOW_DAYS, recentDays: RECENT_DAYS },
    sdkNames: Object.fromEntries(SDKS.map((s) => [s.value, s.name])),
    series,
    comparisons: paramComparisons(series, historyOf),
    testsSeen: testsSeen(inRange, addDays(end, -(WINDOW_DAYS - 1)), end),
    source: {
      records: inRange.length,
      scraped: inRange.filter((r) => r.source === "run-log-scrape").length,
      archive: inRange.filter((r) => r.source === "run-archive-junit").length,
      unreadableRuns: manifestsInRange
        .filter((m) => m.status !== "ok")
        .map((m) => ({ date: m.date, runId: m.runId, status: m.status, reason: m.reason }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    },
  };
  return { ...report, digest: buildDigest(report) };
}


function testsSeen(records: RunRecord[], from: string, to: string): HealthReport["testsSeen"] {
  const out: HealthReport["testsSeen"] = { functional: { tests: [], complete: true }, situational: { tests: [], complete: true } };
  const seen = { functional: new Set<string>(), situational: new Set<string>() };
  for (const r of records) {
    if (r.date < from || r.date > to || !r.counts) continue;
    if (!r.passesKnown) out[r.kind].complete = false;
    for (const [cls, o] of Object.entries(r.tests)) {
      for (const m of [...(o.p ?? []), ...(o.f ?? []), ...(o.e ?? [])]) seen[r.kind].add(`${cls}.${m}`);
      if (o.classError) seen[r.kind].add(cls);
    }
  }
  for (const k of ["functional", "situational"] as const) out[k].tests = [...seen[k]].sort();
  return out;
}

/** The tests a report follows up: every one that isn't dormant, in a series that is still active. */
export function reportFindings(report: Pick<HealthReport, "series">): { series: ReportSeries; test: ReportTest }[] {
  return report.series.filter((s) => s.active).flatMap((series) => series.tests.filter((t) => t.cls !== "dormant").map((test) => ({ series, test })));
}
