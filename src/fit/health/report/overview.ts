/**
 * The overview: every SDK's last WINDOW_DAYS nights at a glance, for the site's top page. One
 * chart per SDK, each on its own scales, so the page reads as each SDK's own trend rather than a
 * league table: failing tests per night as bars, tests run per night as a line.
 *
 * Built from each SDK's published report alone - the per-night counts every series already
 * carries (`testCounts`) - so it needs nothing beyond what the SDK pages publish.
 */
import type { HealthReport, ReportSeries } from "./build-report.js";
import { addDays } from "./build-report.js";
import { WINDOW_DAYS } from "./classify.js";

export const OVERVIEW_SCHEMA = "fit-health-overview/1";

/** The parts of a report the overview reads. */
export type OverviewInput = Pick<HealthReport, "sdk" | "generatedAt" | "start" | "end"> & {
  series: Pick<ReportSeries, "testCounts">[];
};

/**
 * One night of one SDK, every series (environment) added together, counted in tests.
 * `logOnly` series left only their CI log: their failures are counted, but their passes and
 * skips are unknown, so `passed` and `skipped` cover the other series only.
 */
export interface OverviewNight {
  date: string;
  passed: number;
  failing: number;
  skipped: number;
  /** Series that ran this night. */
  runs: number;
  /** Of those, how many have no JUnit (passes unknown). */
  logOnly: number;
}

/**
 * A night in the window: the night's counts, "none" when no nightly ran, or "unreported" when
 * the night is outside the SDK's report (before its data starts, or after a report that was
 * carried over from an earlier run) - a night we know nothing about, not one that didn't run.
 */
export type OverviewDay = OverviewNight | "none" | "unreported";

export interface OverviewSdk {
  sdk: string;
  name: string;
  /** The SDK report's own end date and when it was generated. */
  end: string;
  generatedAt: string;
  /** One per date in the overview's `dates`. */
  days: OverviewDay[];
  /** The newest night the SDK ran, in or before the window. */
  latest?: OverviewNight;
}

export interface Overview {
  schema: typeof OVERVIEW_SCHEMA;
  generatedAt: string;
  windowDays: number;
  /** The window, oldest first: WINDOW_DAYS calendar days ending on the newest report's end. */
  dates: string[];
  /** SDKs in name order: the page doesn't rank them. */
  sdks: OverviewSdk[];
  /** SDKs on the site with no report data to draw (only a link). */
  missing: { sdk: string; name: string }[];
}

/** Every series' counts for each night, added together. */
export function nightTotals(series: OverviewInput["series"]): Map<string, OverviewNight> {
  const nights = new Map<string, OverviewNight>();
  for (const s of series) {
    for (const [date, c] of Object.entries(s.testCounts)) {
      let n = nights.get(date);
      if (!n) nights.set(date, (n = { date, passed: 0, failing: 0, skipped: 0, runs: 0, logOnly: 0 }));
      n.runs++;
      n.failing += c.failing;
      if (c.tests === undefined) {
        n.logOnly++;
      } else {
        n.passed += c.passed ?? 0;
        n.skipped += c.skipped ?? 0;
      }
    }
  }
  return nights;
}

export function buildOverview(
  reports: { input: OverviewInput; name: string }[],
  missing: { sdk: string; name: string }[] = [],
  now = new Date(),
  windowDays = WINDOW_DAYS,
): Overview {
  const end = reports.map((r) => r.input.end).sort().at(-1);
  const dates: string[] = [];
  if (end) for (let k = windowDays - 1; k >= 0; k--) dates.push(addDays(end, -k));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "en");
  const sdks = reports.map(({ input, name }): OverviewSdk => {
    const nights = nightTotals(input.series);
    const days = dates.map((d): OverviewDay => (d < input.start || d > input.end ? "unreported" : nights.get(d) ?? "none"));
    const latestDate = [...nights.keys()].filter((d) => d <= input.end).sort().at(-1);
    return {
      sdk: input.sdk,
      name,
      end: input.end,
      generatedAt: input.generatedAt,
      days,
      latest: latestDate ? nights.get(latestDate) : undefined,
    };
  });
  return {
    schema: OVERVIEW_SCHEMA,
    generatedAt: now.toISOString(),
    windowDays,
    dates,
    sdks: sdks.sort(byName),
    missing: [...missing].sort(byName),
  };
}
