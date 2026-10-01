/**
 * The triage report: a per-SDK JSON contract for tools that act on the health report (a triage
 * agent, first). It is built from the same report as the page, so the two never disagree, but
 * unlike `health-report.json` - the page's own drawing data, which changes with the page - its
 * shape is versioned and documented in specs/health.md. A field is only ever added within a
 * schema version; anything else bumps it.
 *
 * Each finding is one test (or one whole class that errored) in one series that is not
 * dormant, with its classification, an explicit night-by-night history, and the evidence to
 * follow up: the CI run, the S3 archive holding its JUnit, and the SDK commits either side of
 * the night it changed.
 */
import type { RunRecord } from "../record/run-record.js";
import { sdkCommitOf, type RunManifest } from "../record/run-manifest.js";
import { RECENT_DAYS, type HealthReport, type ReportNotes, type ReportSeries, type ReportTest } from "./build-report.js";
import { CLASS_LABELS, WINDOW_DAYS, isFailure, type NightOutcome, type TestClass } from "./classify.js";
import { buildSeries, type Series } from "./series.js";
import type { ChangeAnalysis, Commit, DriverChanges } from "./changes.js";

export const TRIAGE_SCHEMA = "fit-health-triage/1" as const;

export type TriageOutcome = "passed" | "failed" | "errored" | "not_run" | "unknown";

const OUTCOME: Record<NightOutcome, TriageOutcome> = { p: "passed", f: "failed", e: "errored", n: "not_run", u: "unknown" };

/** One night of one series, with where to find out more. */
export interface TriageNight {
  date: string;
  outcome: TriageOutcome;
  /** The CI run that produced it. */
  run: { url: string; repo: string; runId: number; attempt: number; job?: string };
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
  cluster?: string;
  /** "run-archive-junit": every outcome is known; "run-log-scrape": only failures are named. */
  source: RunRecord["source"];
}

export interface TriageFinding {
  /** Exact test id: "Class.method", or "Class" for a whole class that errored. */
  test: string;
  class: string;
  /** Null for a whole-class error. */
  method: string | null;
  /** The series id (see `series[]`). */
  series: string;
  classification: {
    class: TestClass;
    label: string;
    /** For "failing": the night the current failure run began. */
    since?: string;
    streak: number;
    episodes: number;
    windowFails: number;
    windowRuns: number;
    lastFail?: string;
    lastPass?: string;
    lastRan?: string;
    /** For "stopped": the first night it didn't run. */
    notRunSince?: string;
  };
  /** Every night the series ran, oldest first. */
  history: { date: string; outcome: TriageOutcome }[];
  evidence: {
    /** First night of the most recent unbroken run of failures. */
    firstFailing?: TriageNight;
    /** The most recent failing night. */
    latestFailing?: TriageNight;
    /** The last passing night before `firstFailing`. */
    lastGood?: TriageNight;
    /** When there is no `lastGood` (the test only just started running): the night before `firstFailing`. */
    previousNight?: TriageNight;
    /**
     * The SDK commits of the baseline (`lastGood`, else `previousNight`) and `firstFailing`.
     * `changed`: this SDK's own code or its shared core changed between them - path-aware in a
     * repo holding several SDKs. The commit lists are filled in when the changes are looked up.
     */
    sdkChange?: { from: string; to: string; changed: boolean; compareUrl?: string; commits?: Commit[]; sharedCoreCommits?: Commit[]; sharedHarnessCommits?: Commit[] };
  };
  notes?: { ticket?: string; text: string };
  /** FIT driver (transactions-fit-performer) commits between the same two nights. Null until computed. */
  driverChanges: DriverChanges | null;
  /** The likely cause, from the SDK and driver changes. Absent until they are computed. */
  changeAnalysis?: ChangeAnalysis;
  /** The same test on other opted-in SDKs. Null until computed. */
  crossSdk: null;
}

export interface TriageReport {
  schema: typeof TRIAGE_SCHEMA;
  sdk: string;
  generatedAt: string;
  window: { start: string; end: string; nights: number; classificationDays: number; recentDays: number };
  coverage: { records: number; fromJunit: number; fromLog: number };
  /** Nights with no usable functional results from any preset (including nights with no run). */
  blackout: string[];
  unreadableRuns: HealthReport["source"]["unreadableRuns"];
  series: {
    id: string;
    preset: string;
    kind: RunRecord["kind"];
    where: string;
    label: string;
    params: Record<string, string | number | boolean>;
    clusters: ReportSeries["clusters"];
    nights: number;
    degraded: string[];
    aborted: ReportSeries["aborted"];
    active: boolean;
  }[];
  findings: TriageFinding[];
}

export function runUrl(ci: RunRecord["ci"]): string {
  return `https://github.com/${ci.repo}/actions/runs/${ci.runId}/attempts/${ci.runAttempt}`;
}

/**
 * The most recent unbroken run of failures, as indexes into `seq`: from its first failing night
 * to its last. Unknown and not-run nights neither break it nor count towards it.
 */
export function latestFailureRun(seq: string): { first: number; last: number } | undefined {
  let last = -1;
  for (let i = seq.length - 1; i >= 0; i--) {
    if (isFailure(seq[i])) {
      last = i;
      break;
    }
  }
  if (last < 0) return undefined;
  let first = last;
  for (let i = last - 1; i >= 0; i--) {
    if (isFailure(seq[i])) first = i;
    else if (seq[i] === "p") break;
  }
  return { first, last };
}

type Manifests = ReadonlyMap<string, RunManifest>;

function night(s: Series, date: string, outcome: NightOutcome, manifests: Manifests): TriageNight | undefined {
  const r = s.nights.find((n) => n.date === date)?.record;
  if (!r) return undefined;
  const sdk = sdkCommitOf(r, manifests.get(`${r.ci.runId}-${r.ci.runAttempt}`));
  return {
    date,
    outcome: OUTCOME[outcome],
    run: { url: runUrl(r.ci), repo: r.ci.repo, runId: r.ci.runId, attempt: r.ci.runAttempt, ...(r.ci.job ? { job: r.ci.job } : {}) },
    ...(sdk.sha ? { sdkCommit: sdk.sha, sdkCommitFrom: sdk.fromImage ? ("performer-image" as const) : ("workflow" as const) } : {}),
    ...(sdk.fromImage && r.ci.sha && r.ci.sha !== sdk.sha ? { workflowCommit: r.ci.sha } : {}),
    ...(r.archive ? { archive: r.archive } : {}),
    ...(r.cluster ? { cluster: r.cluster } : {}),
    source: r.source,
  };
}

function finding(rs: ReportSeries, s: Series, t: ReportTest, notes: ReportNotes, manifests: Manifests): TriageFinding {
  const seq = t.seq;
  const at = (i: number) => seq[i] as NightOutcome;
  const run = latestFailureRun(seq);
  let lastGoodIndex = -1;
  if (run) for (let i = run.first - 1; i >= 0; i--) if (at(i) === "p") { lastGoodIndex = i; break; }
  let lastPassIndex = -1;
  for (let i = seq.length - 1; i >= 0; i--) if (at(i) === "p") { lastPassIndex = i; break; }
  let lastRanIndex = -1;
  for (let i = seq.length - 1; i >= 0; i--) if (at(i) === "p" || isFailure(at(i))) { lastRanIndex = i; break; }

  const firstFailing = run ? night(s, rs.ran[run.first], at(run.first), manifests) : undefined;
  const latestFailing = run ? night(s, rs.ran[run.last], at(run.last), manifests) : undefined;
  const lastGood = lastGoodIndex >= 0 ? night(s, rs.ran[lastGoodIndex], "p", manifests) : undefined;
  const previousNight = run && !lastGood && run.first > 0 ? night(s, rs.ran[run.first - 1], at(run.first - 1), manifests) : undefined;
  const from = (lastGood ?? previousNight)?.sdkCommit;
  const to = firstFailing?.sdkCommit;
  const repo = (firstFailing ?? lastGood)?.run.repo;
  const sdkChange = from && to
    ? { from, to, changed: from !== to, ...(from !== to && repo ? { compareUrl: `https://github.com/${repo}/compare/${from}...${to}` } : {}) }
    : undefined;

  const dot = t.test.indexOf(".");
  const fix = notes.fixes?.[t.test];
  return {
    test: t.test,
    class: dot < 0 ? t.test : t.test.slice(0, dot),
    method: dot < 0 ? null : t.test.slice(dot + 1),
    series: rs.id,
    classification: {
      class: t.cls,
      label: CLASS_LABELS[t.cls],
      ...(t.since ? { since: t.since } : {}),
      streak: t.streak,
      episodes: t.episodes,
      windowFails: t.windowFails,
      windowRuns: t.windowRuns,
      ...(t.lastFail ? { lastFail: t.lastFail } : {}),
      ...(lastPassIndex >= 0 ? { lastPass: rs.ran[lastPassIndex] } : {}),
      ...(lastRanIndex >= 0 ? { lastRan: rs.ran[lastRanIndex] } : {}),
      ...(t.notRunSince ? { notRunSince: t.notRunSince } : {}),
    },
    history: rs.ran.map((date, i) => ({ date, outcome: OUTCOME[at(i)] })),
    evidence: {
      ...(firstFailing ? { firstFailing } : {}),
      ...(latestFailing ? { latestFailing } : {}),
      ...(lastGood ? { lastGood } : {}),
      ...(previousNight ? { previousNight } : {}),
      ...(sdkChange ? { sdkChange } : {}),
    },
    ...(fix ? { notes: fix } : {}),
    driverChanges: null,
    crossSdk: null,
  };
}

/**
 * The triage report for `report`. `records` and `notes` are what it was built from; only the
 * records in the report's window are used, so the series - and their ids - are the report's own.
 */
export function buildTriageReport(report: HealthReport, records: RunRecord[], notes: ReportNotes = {}, manifests: RunManifest[] = []): TriageReport {
  const manifestOf: Manifests = new Map(manifests.map((m) => [`${m.runId}-${m.runAttempt}`, m]));
  const inWindow = records.filter((r) => r.date >= report.start && r.date <= report.end);
  const built = new Map(buildSeries(inWindow).map((s) => [s.id, s]));
  const findings: TriageFinding[] = [];
  for (const rs of report.series) {
    const s = built.get(rs.id);
    if (!rs.active || !s) continue;
    for (const t of rs.tests) if (t.cls !== "dormant") findings.push(finding(rs, s, t, notes, manifestOf));
  }
  return {
    schema: TRIAGE_SCHEMA,
    sdk: report.sdk,
    generatedAt: report.generatedAt,
    window: { start: report.start, end: report.end, nights: report.dates.length, classificationDays: WINDOW_DAYS, recentDays: RECENT_DAYS },
    coverage: { records: report.source.records, fromJunit: report.source.archive + report.source.emitted, fromLog: report.source.scraped },
    blackout: report.blackout,
    unreadableRuns: report.source.unreadableRuns,
    series: report.series.map((rs) => ({
      id: rs.id,
      preset: rs.preset,
      kind: rs.kind,
      where: rs.short,
      label: rs.label,
      params: rs.params,
      clusters: rs.clusters,
      nights: rs.ran.length,
      degraded: rs.degraded,
      aborted: rs.aborted,
      active: rs.active,
    })),
    findings,
  };
}
