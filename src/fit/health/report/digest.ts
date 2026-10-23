/**
 * The digest of a health report: the lists and counts every view leads with - what failed
 * last night, what keeps failing, what started and stopped failing, what stopped running, last night's test counts, and what
 * the data can't vouch for. Built once here, over the active functional series, and carried in
 * report.json; the page, Slack, Markdown and terminal renderers only format it.
 *
 * Situational presets are kept out: they run a handful of scored scenarios, and the page shows
 * them on their own.
 */
import type { HealthReport, NightTests, ReportSeries } from "./build-report.js";
import type { TestClass } from "./classify.js";
import { cleanNights, isCounted } from "./clean.js";
import { addDays, daysBetween } from "./dates.js";

/** A total over the functional series, and each one's part of it by short name. */
export interface DigestCount {
  total: number;
  bySeries: { series: string; n: number }[];
}

/** Where an item came from: the series id (to find its test) and its short name (to show). */
interface Where {
  series: string;
  where: string;
}

/** Tests of one class that started failing on the same night in the same series. */
export interface StartedGroup extends Where {
  cls: string;
  tests: string[];
  since: string;
  nights: number;
}

export interface StartedTest {
  test: string;
  since: string;
  nights: number;
}

export interface StoppedTest {
  test: string;
  last: string;
  run: number;
  clean: number;
  fix?: { ticket?: string; text: string };
}

export interface StoppedRunningTest {
  test: string;
  lastRan: string;
  lastResult: "p" | "f" | "e";
  since: string;
}

/**
 * A series' tests that started failing in the last `recentDays` days to `end`. One failing
 * since the series' first night isn't known to have started then, so isn't listed.
 */
export function startedTests(s: Pick<ReportSeries, "tests">, end: string, recentDays: number): StartedTest[] {
  return s.tests
    .filter((t) => t.cls === "failing" && t.streak && t.since && !t.sinceFirstNight && daysBetween(t.since, end) < recentDays)
    .map((t) => ({ test: t.test, since: t.since!, nights: t.streak }));
}

/** A series' tests that stopped failing in the last `recentDays` days to `end`. */
export function stoppedTests(s: Pick<ReportSeries, "tests">, end: string, recentDays: number): StoppedTest[] {
  return s.tests
    .filter((t) => t.cls === "recovered" && t.lastFail && daysBetween(t.lastFail, end) < recentDays)
    .map((t) => ({ test: t.test, last: t.lastFail!, run: t.lastEpisode!.nights, clean: t.cleanTail, fix: t.fix }));
}

/**
 * A series' tests that failed and then stopped running. The report keeps such a test in
 * `tests` only for its recent days, so these are the ones that stopped recently.
 */
export function stoppedRunningTests(s: Pick<ReportSeries, "tests">): StoppedRunningTest[] {
  return s.tests
    .filter((t) => t.cls === "stopped")
    .map((t) => ({ test: t.test, lastRan: t.lastRan!, lastResult: t.lastResult!, since: t.notRunSince! }));
}

/**
 * The tests that failed or errored on the report's end date, in the series that ran then, split
 * by class so a reader can tell a new break from a known flake at a glance.
 */
export interface FailedLastNight extends DigestCount {
  /** Failing every night in the window, or 3+ nights in a row (the `persistent` count). */
  persistent: number;
  /** Failing the last 1-2 nights after a clean window. */
  new: number;
  /** A current failure on a test that already flipped in the window. */
  intermittent: number;
  /**
   * A series' last night was read from the CI log only, which names at most a few failures per
   * package: the total is a minimum.
   */
  atLeast: boolean;
  tests: ({ test: string; cls: TestClass } & Where)[];
}

export interface Digest {
  /** Failing every night they ran in the window, or 3+ nights in a row: what keeps failing. */
  persistent: DigestCount;
  /** Absent when no functional series ran on the report's end date. */
  failedLastNight?: FailedLastNight;
  started: DigestCount;
  stopped: DigestCount;
  intermittent: DigestCount;
  /** Newest first. */
  startedGroups: StartedGroup[];
  stoppedTests: (StoppedTest & Where)[];
  stoppedRunning: (StoppedRunningTest & Where)[];
  /** Tests that failed every night they ran in the classification window. */
  always: ({ test: string } & Where)[];
  /**
   * Last night's tests, from the series whose latest night is the report's end and usable;
   * absent when none is.
   */
  lastNight?: { tests: number; skipped: number; testCases: number; bySeries: { series: string; tests: number }[] };
  /** The report's clean nights (clean.ts), oldest first. */
  cleanNights: string[];
  /** In the classification window: nights with no usable results, and runs with no readable log. */
  gaps: string[];
  unreadableRuns: HealthReport["source"]["unreadableRuns"];
}

/** The class of a test id; a bare class name is a class-level error. */
export function testClass(test: string): string {
  const dot = test.indexOf(".");
  return dot < 0 ? test : test.slice(0, dot);
}

/** The method part of a test id: "(whole class)" for a class-level error. */
export function testMethod(test: string): string {
  const dot = test.indexOf(".");
  return dot < 0 ? "(whole class)" : test.slice(dot + 1);
}

export function buildDigest(report: Omit<HealthReport, "digest">): Digest {
  const func = report.series.filter(isCounted);
  const count = (f: (s: ReportSeries) => number): DigestCount => {
    const bySeries = func.map((s) => ({ series: s.short, n: f(s) }));
    return { total: bySeries.reduce((a, x) => a + x.n, 0), bySeries };
  };
  const each = <T>(f: (s: ReportSeries) => T[]) => func.flatMap((s) => f(s).map((x) => ({ ...x, series: s.id, where: s.short })));
  const { end } = report;
  const recent = report.classes.recentDays;

  const startedGroups: StartedGroup[] = [];
  for (const t of each((s) => startedTests(s, end, recent))) {
    const cls = testClass(t.test);
    const g = startedGroups.find((x) => x.cls === cls && x.since === t.since && x.series === t.series);
    if (g) g.tests.push(t.test);
    else startedGroups.push({ cls, tests: [t.test], since: t.since, nights: t.nights, series: t.series, where: t.where });
  }
  startedGroups.sort((a, b) => b.since.localeCompare(a.since));

  const known = func.filter((s): s is ReportSeries & { latest: Required<NightTests> } => !!s.latest?.usable && s.latest.tests != null);
  const ran = (s: (typeof known)[number]) => s.latest.passed + s.latest.failing;
  const windowStart = addDays(report.end, -(report.classes.windowDays - 1));

  // Last night: the series whose latest night is the end date and usable, JUnit or log.
  const lastRan = func.filter((s) => s.latest?.usable && s.latest.date === end);
  const failedOnEnd = (s: ReportSeries) => s.tests.filter((t) => t.seq.length === s.ran.length && /[fe]$/.test(t.seq));
  const lastFails = lastRan.flatMap((s) => failedOnEnd(s).map((t) => ({ test: t.test, cls: t.cls, series: s.id, where: s.short })));
  const inClasses = (...c: TestClass[]) => lastFails.filter((t) => c.includes(t.cls)).length;

  return {
    persistent: count((s) => s.counts.always + s.counts.failing),
    ...(lastRan.length
      ? {
          failedLastNight: {
            total: lastFails.length,
            bySeries: lastRan.map((s) => ({ series: s.short, n: failedOnEnd(s).length })),
            persistent: inClasses("always", "failing"),
            new: inClasses("new"),
            intermittent: inClasses("intermittent"),
            atLeast: lastRan.some((s) => s.latest!.tests == null),
            tests: lastFails,
          },
        }
      : {}),
    started: count((s) => startedTests(s, end, recent).length),
    stopped: count((s) => stoppedTests(s, end, recent).length),
    intermittent: count((s) => s.counts.intermittent),
    startedGroups,
    stoppedTests: each((s) => stoppedTests(s, end, recent)),
    stoppedRunning: each(stoppedRunningTests),
    always: each((s) => s.tests.filter((t) => t.cls === "always").map((t) => ({ test: t.test }))),
    ...(known.length
      ? {
          lastNight: {
            tests: known.reduce((a, s) => a + ran(s), 0),
            skipped: known.reduce((a, s) => a + s.latest.skipped, 0),
            testCases: known.reduce((a, s) => a + s.latest.testCases, 0),
            bySeries: known.map((s) => ({ series: s.short, tests: ran(s) })),
          },
        }
      : {}),
    cleanNights: cleanNights(report.series, report.dates),
    gaps: report.blackout.filter((d) => d >= windowStart),
    unreadableRuns: report.source.unreadableRuns.filter((r) => r.date >= windowStart),
  };
}
