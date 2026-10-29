/**
 * The overview: every SDK's last WINDOW_DAYS nights at a glance, for the site's top page. One
 * chart per SDK, each on its own scales, so the page reads as each SDK's own trend rather than a
 * league table: failing tests per night as bars, tests run per night as a line.
 *
 * The charts are grouped by language - one row per language (in effect, per team), its Couchbase
 * SDK first, then its Operational Insights and Columnar SDKs - and the languages whose Couchbase
 * SDKs share a core (the JVM, the C++ core) are grouped into a section for that core.
 *
 * Built from each SDK's published report alone - the per-night counts every series already
 * carries (`testCounts`) - so it needs nothing beyond what the SDK pages publish. It counts the
 * series the SDK pages lead with (clean.ts), so its numbers are theirs.
 */
import type { HealthReport, ReportSeries } from "./build-report.js";
import { FAMILY_SECTIONS, type HealthOptIn } from "../registry/health-opt-ins.js";
import { SDKS, sdkByValue } from "../../../util/sdk/sdks.js";
import { addDays } from "./dates.js";
import { WINDOW_DAYS } from "./classify.js";
import { isClean, isCounted, type CleanSeries } from "./clean.js";

/** The parts of a report the overview reads. */
export type OverviewInput = Pick<HealthReport, "sdk" | "start" | "end"> & {
  series: (CleanSeries & Partial<Pick<ReportSeries, "aborted">>)[];
  source?: Pick<HealthReport["source"], "unreadableRuns">;
};

/**
 * One night of one SDK, every counted series (environment) added together, counted in tests.
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
  /** Nothing to fix: every counted series ran, gave full results and failed nothing (clean.ts). */
  clean: boolean;
}

/**
 * A night in the window: the night's counts, or why there are none - "aborted" when the nightly
 * ran but every run aborted before it had results, "unreadable" when a run's log could not be
 * read, "none" when no nightly ran, or "unreported" when the night is outside the SDK's report
 * (before its data starts, or after a report that was carried over from an earlier run) - a
 * night we know nothing about, not one that didn't run.
 */
export type OverviewDay = OverviewNight | "aborted" | "unreadable" | "none" | "unreported";

export interface OverviewSdk {
  sdk: string;
  name: string;
  /** What the SDK is, within its row: "SDK", "Operational Insights", "Columnar". */
  product: string;
  /** The SDK report's own end date: its latest night, which can be the day before another SDK's. */
  end: string;
  /** The report is the one on the published site, kept because this run had none for the SDK. */
  carried?: true;
  /** One per date in the overview's `dates`. */
  days: OverviewDay[];
  /** The newest night the SDK ran, in or before the window. */
  latest?: OverviewNight;
  /**
   * How the SDK's own latest night (`end`) went: "clean", "failing" (a test failed), or "none"
   * (no full results that night: it didn't run, aborted, or some of it came only from the log).
   */
  state: OverviewState;
}

export type OverviewState = "clean" | "failing" | "none";

export interface Overview {
  /** When the page was built, shown in its header. */
  generatedAt: string;
  windowDays: number;
  /** The window, oldest first: WINDOW_DAYS calendar days ending on the newest report's end. */
  dates: string[];
  /** SDKs in name order: the page doesn't rank them. */
  sdks: OverviewSdk[];
  /** SDKs on the site with no report data to draw (only a link). */
  missing: OverviewMissing[];
  /** The page's layout, by SDK value: the core sections first, then the languages on their own. */
  sections: OverviewSection[];
}

export interface OverviewMissing {
  sdk: string;
  name: string;
  product: string;
}

/** A language's row: its SDKs on the site, Couchbase SDK first. */
export interface OverviewRow {
  language: string;
  name: string;
  sdks: string[];
}

/** A group of rows. A section without a title is one language on its own. */
export interface OverviewSection {
  title?: string;
  description?: string;
  rows: OverviewRow[];
}

/** Where an SDK goes on the page: its language's row, and that row's section (if any). */
export interface Placement {
  language: string;
  product: string;
  family?: string;
}

/**
 * Place an SDK. Its row is its opt-in's `language` (an SDK that is a Couchbase SDK is its own
 * language); the row's section is the family of that language's Couchbase SDK, not the SDK's
 * own - insights-node goes in the C++ core section because node is in it.
 */
export function placeSdk(sdk: string, optIns: Record<string, Pick<HealthOptIn, "family" | "language"> | undefined>): Placement {
  const language = optIns[sdk]?.language ?? sdk;
  return { language, product: productName(sdk, language), family: optIns[language]?.family };
}

/** "SDK" for a Couchbase SDK; otherwise its name without the language: "Java Columnar" -> "Columnar". */
export function productName(sdk: string, language: string): string {
  const s = sdkByValue(sdk);
  if (!s || s.family === "operational") return "SDK";
  const lang = sdkByValue(language)?.name;
  return lang && s.name.startsWith(`${lang} `) ? s.name.slice(lang.length + 1) : s.name;
}

/** Products in the order the SDK registry first lists their kind: Couchbase SDKs first. */
const productRank = (sdk: string): number => {
  const family = sdkByValue(sdk)?.family;
  const i = SDKS.findIndex((s) => s.family === family);
  return i < 0 ? SDKS.length : i;
};

const languageName = (language: string): string => sdkByValue(language)?.name ?? language;
const byText = (a: string, b: string) => a.localeCompare(b, "en");

/** Group the SDKs into sections of language rows, everything in name order (not ranked). */
export function layoutSections(sdks: string[], place: (sdk: string) => Placement): OverviewSection[] {
  const rows = new Map<string, { row: OverviewRow; family?: string }>();
  for (const sdk of sdks) {
    const p = place(sdk);
    let r = rows.get(p.language);
    if (!r) rows.set(p.language, (r = { row: { language: p.language, name: languageName(p.language), sdks: [] }, family: p.family }));
    r.row.sdks.push(sdk);
  }
  for (const { row } of rows.values()) {
    row.sdks.sort((a, b) => productRank(a) - productRank(b) || byText(sdkByValue(a)?.name ?? a, sdkByValue(b)?.name ?? b));
  }
  const families = new Map<string, OverviewRow[]>();
  const alone: OverviewRow[] = [];
  for (const { row, family } of rows.values()) {
    if (family) families.set(family, [...(families.get(family) ?? []), row]);
    else alone.push(row);
  }
  const sections = [...families].map(([family, rs]): OverviewSection => ({
    title: FAMILY_SECTIONS[family]?.title ?? family,
    ...(FAMILY_SECTIONS[family] ? { description: FAMILY_SECTIONS[family].description } : {}),
    rows: rs.sort((a, b) => byText(a.name, b.name)),
  }));
  sections.sort((a, b) => byText(a.title!, b.title!));
  return [...sections, ...alone.sort((a, b) => byText(a.name, b.name)).map((row) => ({ rows: [row] }))];
}

/** Every counted series' counts for each night, added together. */
export function nightTotals(series: OverviewInput["series"]): Map<string, OverviewNight> {
  const nights = new Map<string, OverviewNight>();
  for (const s of series.filter(isCounted)) {
    for (const [date, c] of Object.entries(s.testCounts)) {
      let n = nights.get(date);
      if (!n) nights.set(date, (n = { date, passed: 0, failing: 0, skipped: 0, runs: 0, logOnly: 0, clean: isClean(series, date) }));
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

/** Each of `dates` for one SDK: its night's counts, or why there are none. */
export function overviewDays(input: OverviewInput, dates: readonly string[], nights = nightTotals(input.series)): OverviewDay[] {
  const aborted = new Set(input.series.filter(isCounted).flatMap((s) => (s.aborted ?? []).map((a) => a.date)));
  const unreadable = new Set((input.source?.unreadableRuns ?? []).map((r) => r.date));
  return dates.map((d): OverviewDay => {
    if (d < input.start || d > input.end) return "unreported";
    return nights.get(d) ?? (aborted.has(d) ? "aborted" : unreadable.has(d) ? "unreadable" : "none");
  });
}

export function buildOverview(
  reports: { input: OverviewInput; name: string; carried?: boolean }[],
  missing: { sdk: string; name: string }[] = [],
  now = new Date(),
  windowDays = WINDOW_DAYS,
  optIns: Record<string, Pick<HealthOptIn, "family" | "language"> | undefined> = {},
): Overview {
  const place = (sdk: string) => placeSdk(sdk, optIns);
  const end = reports.map((r) => r.input.end).sort().at(-1);
  const dates: string[] = [];
  if (end) for (let k = windowDays - 1; k >= 0; k--) dates.push(addDays(end, -k));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "en");
  const sdks = reports.map(({ input, name, carried }): OverviewSdk => {
    const nights = nightTotals(input.series);
    const days = overviewDays(input, dates, nights);
    const latestDate = [...nights.keys()].filter((d) => d <= input.end).sort().at(-1);
    const last = nights.get(input.end);
    return {
      sdk: input.sdk,
      name,
      product: place(input.sdk).product,
      end: input.end,
      ...(carried ? { carried: true as const } : {}),
      days,
      latest: latestDate ? nights.get(latestDate) : undefined,
      state: last?.clean ? "clean" : last && last.failing > 0 ? "failing" : "none",
    };
  });
  return {
    generatedAt: now.toISOString(),
    windowDays,
    dates,
    sdks: sdks.sort(byName),
    missing: missing.map((m) => ({ ...m, product: place(m.sdk).product })).sort(byName),
    sections: layoutSections([...reports.map((r) => r.input.sdk), ...missing.map((m) => m.sdk)], place),
  };
}
