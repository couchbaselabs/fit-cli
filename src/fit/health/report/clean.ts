/**
 * Which series the headlines count, and when a night is clean.
 *
 * Every view that leads with a number - the digest, the top page, the weekly wrap-up - counts the
 * active functional series. The situational presets (today, the Capella scenarios) stay out until
 * their infrastructure is stable enough for a failure to say something about the SDK: they are
 * still on each SDK's page. To count them, change `isCounted`.
 *
 * A clean night is one with nothing to fix: every counted series that had started by then (had
 * results, or aborted trying) ran, gave full results (JUnit, not only the CI log, and not degraded) and failed nothing. Skipped
 * tests don't spoil it.
 */
import type { ReportSeries } from "./build-report.js";

/** A series the headlines count. */
export const isCounted = (s: Pick<ReportSeries, "kind" | "active">): boolean => s.active && s.kind === "functional";

/** The parts of a series `isClean` reads. */
export type CleanSeries = Pick<ReportSeries, "kind" | "active" | "ran" | "testCounts" | "perNight"> & Partial<Pick<ReportSeries, "aborted">>;

/** The first night a series ran, with results or not: an abort before any results is a start. */
const started = (s: CleanSeries): string | undefined => [...s.ran.slice(0, 1), ...(s.aborted ?? []).map((a) => a.date)].sort()[0];

/** Whether `date` was a clean night across the counted series. */
export function isClean(series: readonly CleanSeries[], date: string): boolean {
  const counted = series.filter(isCounted);
  // A series that hadn't started by then isn't missing from that night.
  const due = counted.filter((s) => {
    const from = started(s);
    return from !== undefined && from <= date;
  });
  if (!due.length) return false;
  return due.every((s) => {
    const c = s.testCounts[date];
    return !!c && c.tests !== undefined && c.failing === 0 && s.perNight[date] === 0;
  });
}

/** The clean nights among `dates`. */
export const cleanNights = (series: readonly CleanSeries[], dates: readonly string[]): string[] => dates.filter((d) => isClean(series, d));
