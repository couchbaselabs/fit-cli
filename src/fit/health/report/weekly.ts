/**
 * The weekly wrap-up: each SDK's last ISO week (Monday to Sunday nights) next to the week
 * before, for SDK teams and managers. Built from two reports per SDK, one ending on each week's
 * Sunday (`fit health report --end`), so it needs nothing the store doesn't already hold.
 *
 * It shows facts and how they changed, never a verdict: no card is called healthy or not. The
 * cards are laid out as on the top page (overview.ts), in its fixed order, so a team always
 * finds its SDK in the same place and nothing reads as a ranking.
 *
 * Everything is counted over one set: the tests failing at a week's end (in a current failure
 * run: always failing, failing, or new), in the active functional series. Each list is a way
 * into or out of that set between the two week ends, so a card always adds up: last week's
 * count, plus started and new failing, minus stopped and no longer counted, is this week's.
 */
import type { ReportSeries } from "./build-report.js";
import type { TestClass } from "./classify.js";
import { addDays } from "./dates.js";
import { layoutSections, overviewDays, placeSdk, type OverviewDay, type OverviewInput, type OverviewNight, type OverviewSection } from "./overview.js";
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
  /** Started: the first night of its current failure run, and how many nights it has failed. */
  since?: string;
  nights?: number;
  /** Stopped, or no longer counted: the last night it failed. */
  last?: string;
  /** No longer counted: why it left the set without passing. */
  why?: "stopped running" | "intermittent" | "not reported";
}

export interface WeeklyCard {
  sdk: string;
  name: string;
  product: string;
  /** Whether there was a report for the week at all. */
  reported: boolean;
  /** The week's 7 nights, Monday first. */
  days: OverviewDay[];
  nightsWithResults: number;
  /** Failing at this week's end and not last week's, having passed before. */
  started: WeeklyTest[];
  /** Failing at this week's end and not last week's, never having passed: new to the run. */
  newFailing: WeeklyTest[];
  /** Failing at last week's end, and passing again at this week's. */
  stopped: WeeklyTest[];
  /** Failing at last week's end, and out of the set at this week's without passing. */
  noLongerCounted: WeeklyTest[];
  /** Tests failing at this week's end, and at last week's (absent with no report then). */
  failing: number;
  failingBefore?: number;
  /** Tests run and skipped on the week's median night (by tests run), counting JUnit nights only. */
  typicalNight?: { date: string; tests: number; skipped: number };
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
const functional = (r: WeeklyInput) => r.series.filter((s) => s.active && s.kind === "functional");
type Test = WeeklyInput["series"][number]["tests"][number];

/** Tests in a current failure run: always failing, failing, or failing their last 1-2 nights. */
export const isFailingAtEnd = (t: Pick<Test, "cls">) => isOn(t.cls, "always", "failing", "new");

/** The tests failing at the end of `r`, keyed by series and test. */
export function failingAtEnd(r: WeeklyInput): Map<string, { s: WeeklyInput["series"][number]; t: Test }> {
  const out = new Map<string, { s: WeeklyInput["series"][number]; t: Test }>();
  for (const s of functional(r)) for (const t of s.tests) if (isFailingAtEnd(t)) out.set(`${s.id}\n${t.test}`, { s, t });
  return out;
}

export interface WeekChanges {
  started: WeeklyTest[];
  newFailing: WeeklyTest[];
  stopped: WeeklyTest[];
  noLongerCounted: WeeklyTest[];
}

/**
 * How the failing set changed from the end of `before` to the end of `now`. With no report for
 * last week, a test counts as joining only if its failure run began this week (`week`).
 */
export function weekChanges(now: WeeklyInput, before: WeeklyInput | undefined, week: IsoWeek): WeekChanges {
  const was = before ? failingAtEnd(before) : undefined;
  const is = failingAtEnd(now);
  const out: WeekChanges = { started: [], newFailing: [], stopped: [], noLongerCounted: [] };
  for (const [key, { s, t }] of is) {
    if (was ? was.has(key) : !(t.since && !t.sinceFirstNight && t.since >= week.start)) continue;
    (t.lastGood ? out.started : out.newFailing).push({ test: t.test, series: s.id, where: s.short, since: t.since, nights: t.streak });
  }
  if (!was) return out;
  const tests = new Map<string, Test>(functional(now).flatMap((s) => s.tests.map((t): [string, Test] => [`${s.id}\n${t.test}`, t])));
  for (const [key, { s }] of was) {
    if (is.has(key)) continue;
    const t = tests.get(key);
    const item = { test: key.slice(key.indexOf("\n") + 1), series: s.id, where: s.short, ...(t?.lastFail ? { last: t.lastFail } : {}) };
    if (t && isOn(t.cls, "recovered", "oneoff", "dormant")) out.stopped.push(item);
    else out.noLongerCounted.push({ ...item, why: !t ? "not reported" : t.cls === "stopped" ? "stopped running" : "intermittent" });
  }
  return out;
}

/** The median night by tests run, over the nights every run of which has JUnit. */
export function typicalNight(days: readonly OverviewDay[]): WeeklyCard["typicalNight"] {
  const full = days
    .filter((d): d is OverviewNight => typeof d !== "string" && d.logOnly === 0)
    .map((d) => ({ date: d.date, tests: d.passed + d.failing, skipped: d.skipped }))
    .sort((a, b) => a.tests - b.tests || a.date.localeCompare(b.date));
  return full.length ? full[Math.floor((full.length - 1) / 2)] : undefined;
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
    const changes: WeekChanges = current ? weekChanges(current, previous, week) : { started: [], newFailing: [], stopped: [], noLongerCounted: [] };
    const failing = current ? failingAtEnd(current).size : 0;
    const failingBefore = previous ? failingAtEnd(previous).size : undefined;
    const moved = changes.started.length + changes.newFailing.length + changes.stopped.length + changes.noLongerCounted.length;
    const typical = typicalNight(days);
    return {
      sdk,
      name,
      product: place(sdk).product,
      reported: !!current,
      days,
      nightsWithResults,
      ...changes,
      failing,
      ...(failingBefore !== undefined ? { failingBefore } : {}),
      ...(typical ? { typicalNight: typical } : {}),
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
