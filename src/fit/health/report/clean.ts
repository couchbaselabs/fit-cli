/**
 * Which series the headlines count, and when a night is clean.
 *
 * Every view that leads with a number - the digest, the top page, the weekly wrap-up - counts every
 * active series: functional and situational (today, the Capella scenarios) alike. A failed Capella
 * scenario spoils a night as much as a failed functional test. An inactive series (none in the
 * window) is still on its SDK's page, but counts nowhere. To change what counts, change `isCounted`.
 *
 * A clean night is one with nothing to fix: every counted series that had started by then (had
 * results, or aborted trying) ran, gave full results (JUnit, not only the CI log, and not degraded) and failed nothing. Skipped
 * tests don't spoil it.
 */
import type { ReportSeries } from "./build-report.js";

/** A series the headlines count. */
export const isCounted = (s: Pick<ReportSeries, "active">): boolean => s.active;

/** The parts of a series `isClean` reads. */
export type CleanSeries = Pick<ReportSeries, "kind" | "active" | "ran" | "testCounts" | "perNight"> & Partial<Pick<ReportSeries, "aborted">>;

/** The first night a series ran, with results or not: an abort before any results is a start. */
const started = (s: CleanSeries): string | undefined => [...s.ran.slice(0, 1), ...(s.aborted ?? []).map((a) => a.date)].sort()[0];

/** Why a counted series gave no full results on a night: none at all, only its CI log, or degraded. */
export type NotFull = "none" | "log" | "degraded";

/** The counted series due on `date` (they had started by then), and those of them without full results. */
function dueOn<S extends CleanSeries>(series: readonly S[], date: string): { due: S[]; notFull: { series: S; why: NotFull }[] } {
  // A series that hadn't started by then isn't missing from that night.
  const due = series.filter(isCounted).filter((s) => {
    const from = started(s);
    return from !== undefined && from <= date;
  });
  const notFull = due.flatMap((s) => {
    const c = s.testCounts[date];
    const why: NotFull | undefined = !c ? "none" : s.perNight[date] === null ? "degraded" : c.tests === undefined ? "log" : undefined;
    return why ? [{ series: s, why }] : [];
  });
  return { due, notFull };
}

/** The counted series that should have run on `date` but gave no full results: each keeps the night from being clean. */
export const notFullOn = <S extends CleanSeries>(series: readonly S[], date: string) => dueOn(series, date).notFull;

/** Whether `date` was a clean night across the counted series. */
export function isClean(series: readonly CleanSeries[], date: string): boolean {
  const { due, notFull } = dueOn(series, date);
  if (!due.length || notFull.length) return false;
  return due.every((s) => s.testCounts[date].failing === 0 && s.perNight[date] === 0);
}

/** The clean nights among `dates`. */
export const cleanNights = (series: readonly CleanSeries[], dates: readonly string[]): string[] => dates.filter((d) => isClean(series, d));
