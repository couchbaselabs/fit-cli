/**
 * The weekly wrap-up: each SDK's last ISO week (Monday to Sunday nights) next to the week
 * before, for SDK teams and managers. Built from two reports per SDK, one ending on each week's
 * Sunday (`fit health report --end`), so it needs nothing the store doesn't already hold.
 *
 * It is the overall picture: per SDK, how many tests are failing, which way that moved since
 * last week, and how many are flaky. The tests behind the move are a click away. The cards are
 * laid out as on the top page (overview.ts), in its fixed order, so a team always finds its SDK
 * in the same place and nothing reads as a ranking.
 *
 * Failing is one set: the tests in a current failure run at a week's end (always failing,
 * failing, or new), in the counted series (clean.ts). Flaky is apart from it: intermittent tests
 * that failed during the week.
 */
import type { ReportSeries } from "./build-report.js";
import type { TestClass } from "./classify.js";
import { isCounted } from "./clean.js";
import { addDays } from "./dates.js";
import { layoutSections, overviewDays, placeSdk, type OverviewDay, type OverviewInput, type OverviewNight, type OverviewSection } from "./overview.js";
import { seriesBaseId } from "./series.js";
import type { HealthOptIn } from "../registry/health-opt-ins.js";

/** An ISO week: `2026-W43`, its Monday and its Sunday. */
export interface IsoWeek {
  id: string;
  start: string;
  end: string;
}

/** The ISO week `date` is in. */
export function isoWeek(date: string): IsoWeek {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay() || 7; // Monday 1 .. Sunday 7
  const start = addDays(date, 1 - day);
  // The week belongs to the year its Thursday is in.
  const thursday = addDays(start, 3);
  const year = Number(thursday.slice(0, 4));
  const week = Math.floor((Date.parse(`${thursday}T00:00:00Z`) - Date.parse(`${year}-01-01T00:00:00Z`)) / 86_400_000 / 7) + 1;
  return { id: `${year}-W${String(week).padStart(2, "0")}`, start, end: addDays(start, 6) };
}

/** The week named `2026-W43`; undefined for anything else. */
export function isoWeekById(id: string): IsoWeek | undefined {
  const m = /^(\d{4})-W(\d{2})$/.exec(id);
  if (!m) return undefined;
  // 4 January is always in week 1.
  const week = isoWeek(addDays(`${m[1]}-01-04`, (Number(m[2]) - 1) * 7));
  return week.id === id ? week : undefined;
}

/** The newest week that ended before `today`: on a Monday, the week to yesterday. */
export function lastFullWeek(today: string): IsoWeek {
  return isoWeek(addDays(today, -7));
}

/** The parts of a report the weekly page reads. */
export type WeeklyInput = Omit<OverviewInput, "series"> & {
  series: (OverviewInput["series"][number] & Pick<ReportSeries, "id" | "short" | "kind" | "active" | "tests">)[];
};

/** A test on a card: where it runs (the series' short name) and its dates. */
export interface WeeklyTest {
  test: string;
  series: string;
  where: string;
  /** Newly failing: the first night of its current failure run, and how many nights it has failed. */
  since?: string;
  nights?: number;
  /** Newly failing, but passing again: the clean nights since, too few yet to leave the set. */
  passedLast?: number;
  /** Newly failing, and it never passed: new to the run. */
  neverPassed?: boolean;
  /** No longer failing, or flaky: the last night it failed. */
  last?: string;
  /** No longer failing without passing again: why it left the set. */
  why?: "stopped running" | "now flaky" | "not reported";
}

export interface WeeklyCard {
  sdk: string;
  name: string;
  product: string;
  /** Whether there was a report for the week at all. */
  reported: boolean;
  /** The week's 7 nights, Monday first. */
  days: OverviewDay[];
  /** Nights with results in the counted series (clean.ts): with none, the SDK has no state for the week. */
  nightsWithResults: number;
  /** Failing at this week's end and not last week's. */
  newlyFailing: WeeklyTest[];
  /** Failing at last week's end and not this week's: passing again, or `why` not. */
  noLongerFailing: WeeklyTest[];
  /** Intermittent at this week's end, and failed during the week. Not in `failing`. */
  flaky: WeeklyTest[];
  /** Tests failing at this week's end, and at last week's (absent with no report then). */
  failing: number;
  failingBefore?: number;
  /** Tests run on the week's median night (by tests run), counting JUnit nights only: the scale for `failing`. */
  testsRun?: number;
  /** No test came into or left the failing set, and every night has results. */
  noChange: boolean;
}

export interface Weekly {
  generatedAt: string;
  week: IsoWeek;
  previous: IsoWeek;
  /** The week's dates, Monday first. */
  dates: string[];
  /** The top page's layout, by SDK value. */
  sections: OverviewSection[];
  cards: WeeklyCard[];
}

const isOn = (cls: TestClass, ...c: TestClass[]) => c.includes(cls);
const counted = (r: WeeklyInput) => r.series.filter(isCounted);
type Test = WeeklyInput["series"][number]["tests"][number];

/** Tests in a current failure run: always failing, failing, or failing their last 1-2 nights. */
export const isFailingAtEnd = (t: Pick<Test, "cls">) => isOn(t.cls, "always", "failing", "new");

/** A series' key when comparing two weeks (see seriesKeys). */
export type SeriesKey = (id: string) => string;

/**
 * How to key the series of `now` and `before` so the two weeks compare. A preset that ran two
 * clusters on one night is split by cluster (series.ts), but only in a report whose window has
 * that night. Where the two weeks split a preset differently, both key it by the preset alone.
 */
export function seriesKeys(now: WeeklyInput, before: WeeklyInput | undefined): SeriesKey {
  if (!before) return (id) => id;
  const split = (r: WeeklyInput) => {
    const out = new Map<string, boolean>();
    for (const s of counted(r)) out.set(seriesBaseId(s.id), out.get(seriesBaseId(s.id)) || s.id !== seriesBaseId(s.id));
    return out;
  };
  const a = split(now);
  const b = split(before);
  const merged = new Set([...a].filter(([base, isSplit]) => b.has(base) && b.get(base) !== isSplit).map(([base]) => base));
  return (id) => (merged.has(seriesBaseId(id)) ? seriesBaseId(id) : id);
}

/** The tests failing at the end of `r`, keyed by series and test. */
export function failingAtEnd(r: WeeklyInput, key: SeriesKey = (id) => id): Map<string, { s: WeeklyInput["series"][number]; t: Test }> {
  const out = new Map<string, { s: WeeklyInput["series"][number]; t: Test }>();
  for (const s of counted(r)) for (const t of s.tests) if (isFailingAtEnd(t)) out.set(`${key(s.id)}\n${t.test}`, { s, t });
  return out;
}

// Where clusters are keyed as one (seriesKeys), a test flaky on one is flaky, and a test that
// stopped on one but runs on another has not stopped running.
const whyRank = (t: Test) => (t.cls === "intermittent" ? 0 : t.cls === "stopped" ? 2 : 1);

export interface WeekChanges {
  newlyFailing: WeeklyTest[];
  noLongerFailing: WeeklyTest[];
}

/**
 * How the failing set changed from the end of `before` to the end of `now`. With no report for
 * last week, a test counts as joining only if its failure run began this week (`week`).
 */
export function weekChanges(now: WeeklyInput, before: WeeklyInput | undefined, week: IsoWeek, key = seriesKeys(now, before)): WeekChanges {
  const was = before ? failingAtEnd(before, key) : undefined;
  const is = failingAtEnd(now, key);
  const out: WeekChanges = { newlyFailing: [], noLongerFailing: [] };
  for (const [key, { s, t }] of is) {
    if (was ? was.has(key) : !(t.since && !t.sinceFirstNight && t.since >= week.start)) continue;
    // A long run followed by 1-2 clean nights is still failing, with no trailing streak: give
    // the run's length, and the clean nights since.
    const passing = !t.streak && t.cleanTail > 0;
    out.newlyFailing.push({
      test: t.test,
      series: s.id,
      where: s.short,
      since: t.since,
      nights: passing ? (t.lastEpisode?.nights ?? t.windowFails) : t.streak,
      ...(passing ? { passedLast: t.cleanTail } : {}),
      ...(t.lastGood ? {} : { neverPassed: true }),
    });
  }
  if (!was) return out;
  const tests = new Map<string, Test>();
  for (const s of counted(now)) {
    for (const t of s.tests) {
      const k = `${key(s.id)}\n${t.test}`;
      const had = tests.get(k);
      if (!had || whyRank(t) < whyRank(had)) tests.set(k, t);
    }
  }
  for (const [key, { s }] of was) {
    if (is.has(key)) continue;
    const t = tests.get(key);
    const item = { test: key.slice(key.indexOf("\n") + 1), series: s.id, where: s.short, ...(t?.lastFail ? { last: t.lastFail } : {}) };
    if (t && isOn(t.cls, "recovered", "oneoff", "dormant")) out.noLongerFailing.push(item);
    else out.noLongerFailing.push({ ...item, why: !t ? "not reported" : t.cls === "stopped" ? "stopped running" : "now flaky" });
  }
  return out;
}

/** The median night's tests run (passed plus failing), over the nights every run of which has JUnit. */
export function typicalTestsRun(days: readonly OverviewDay[]): number | undefined {
  const runs = days
    .filter((d): d is OverviewNight => typeof d !== "string" && d.logOnly === 0)
    .map((d) => d.passed + d.failing)
    .sort((a, b) => a - b);
  return runs.length ? runs[Math.floor((runs.length - 1) / 2)] : undefined;
}

/** The intermittent tests that failed during `week`, at the end of `r`. */
export function flakyIn(r: WeeklyInput, week: IsoWeek): WeeklyTest[] {
  return counted(r).flatMap((s) =>
    s.tests
      .filter((t) => t.cls === "intermittent" && t.lastFail && t.lastFail >= week.start && t.lastFail <= week.end)
      .map((t) => ({ test: t.test, series: s.id, where: s.short, last: t.lastFail })),
  );
}

export function buildWeekly(
  sdks: { sdk: string; name: string; current?: WeeklyInput; previous?: WeeklyInput }[],
  week: IsoWeek,
  now = new Date(),
  optIns: Record<string, Pick<HealthOptIn, "family" | "language"> | undefined> = {},
): Weekly {
  const place = (sdk: string) => placeSdk(sdk, optIns);
  const dates = Array.from({ length: 7 }, (_, k) => addDays(week.start, k));
  const cards = sdks.map(({ sdk, name, current, previous }): WeeklyCard => {
    const days = current ? overviewDays(current, dates) : dates.map((): OverviewDay => "unreported");
    const nightsWithResults = days.filter((d) => typeof d !== "string").length;
    const key = current ? seriesKeys(current, previous) : undefined;
    const changes: WeekChanges = current ? weekChanges(current, previous, week, key) : { newlyFailing: [], noLongerFailing: [] };
    const failing = current ? failingAtEnd(current, key).size : 0;
    const failingBefore = previous ? failingAtEnd(previous, key).size : undefined;
    const moved = changes.newlyFailing.length + changes.noLongerFailing.length;
    const testsRun = current ? typicalTestsRun(days) : undefined;
    return {
      sdk,
      name,
      product: place(sdk).product,
      reported: !!current,
      days,
      nightsWithResults,
      ...changes,
      flaky: current ? flakyIn(current, week) : [],
      failing,
      ...(failingBefore !== undefined ? { failingBefore } : {}),
      ...(testsRun !== undefined ? { testsRun } : {}),
      noChange: !!current && failingBefore !== undefined && !moved && nightsWithResults === dates.length,
    };
  });
  return {
    generatedAt: now.toISOString(),
    week,
    previous: isoWeek(addDays(week.start, -7)),
    dates,
    sections: layoutSections(
      sdks.map((s) => s.sdk),
      place,
    ),
    cards: cards.sort((a, b) => a.name.localeCompare(b.name, "en")),
  };
}

/** One week in the site's weekly/index.json. */
export interface WeekEntry extends IsoWeek {
  /** SDKs with anything to report: a test moved, or a night had no results. */
  changed: number;
  sdks: number;
}

export const weekEntry = (w: Weekly): WeekEntry => ({ ...w.week, changed: w.cards.filter((c) => !c.noChange).length, sdks: w.cards.length });
