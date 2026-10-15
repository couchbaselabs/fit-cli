/**
 * Calendar-day arithmetic on YYYY-MM-DD dates, all in UTC: a FIT night is named by its UTC
 * date, and every report date is one.
 */

const DAY_MS = 86_400_000;

const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** `date` moved by `n` days (negative for earlier), as YYYY-MM-DD. */
export function addDays(date: string, n: number): string {
  return new Date(dayStart(date) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Each day from `from` to `to` inclusive, as YYYY-MM-DD; empty when `from` is missing or later. */
export function calendarDays(from: string | undefined, to: string): string[] {
  const out: string[] = [];
  if (!from) return out;
  for (let t = dayStart(from), last = dayStart(to); t <= last; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Whole days from `a` to `b`: negative when `b` is earlier. */
export function daysBetween(a: string, b: string): number {
  return Math.round((dayStart(b) - dayStart(a)) / DAY_MS);
}

/** The instant `date` begins, as an ISO timestamp (for APIs that take one, such as GitHub's). */
export function startOfDay(date: string): string {
  return new Date(dayStart(date)).toISOString();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-07" -> "7 Oct". */
export const shortDate = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
