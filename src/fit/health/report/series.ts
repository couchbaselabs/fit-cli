/**
 * Group run records into series - the unit a test's history is judged within - and turn each
 * series into per-test, per-night outcomes.
 *
 * A series is one preset's runs of one test type. A server-version change over time (on-prem
 * 8.0-stable -> 8.5-stable) stays one series, so the history isn't cut in two; but a preset
 * that runs two clusters on the SAME night (qe-set ran 8.0 and 7.6) is split by cluster.
 * Presets are never merged, even when they print identical tags: op-capella-sit-lite and
 * op-capella-pe-sit-lite differ only by their private-endpoint parameter.
 */
import { failingTests, type RunRecord } from "../record/run-record.js";
import type { NightOutcome } from "./classify.js";

/** A night naming far more errored tests than usual is a harness burst, not SDK results. */
const DEGRADED_ERR_MIN = 10;
const DEGRADED_ERR_FACTOR = 3;
/** A night reporting fewer tests than this share of usual died part-way through. */
const TRUNCATED_FRACTION = 0.9;

export interface SeriesNight {
  date: string;
  record: RunRecord;
  /** Distinct failing tests named (class-level aborts excluded). */
  failing: string[];
}

export interface Series {
  id: string;
  preset: string;
  kind: RunRecord["kind"];
  suite: string;
  params: Record<string, string | number | boolean>;
  /** Cluster per night; changes over time are shown, not split. */
  clusters: Record<string, string | undefined>;
  passesKnown: boolean;
  /** Nights with a results table, oldest first. */
  ran: string[];
  /** Nights the run started but produced no results, with fit-cli's reason. */
  aborted: { date: string; level?: string; reason?: string }[];
  /** Nights whose silences can't be read as passes (errored bursts), and truncated ones. */
  degraded: string[];
  truncated: string[];
  nights: SeriesNight[];
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** A preset runs one suite per test type, so preset + kind identifies the series. */
function seriesBaseKey(r: RunRecord): string {
  return `${r.preset}|${r.kind}`;
}

/** Only each night's latest run attempt counts: a re-run replaces the run it re-ran. */
export function latestAttempts(records: RunRecord[]): RunRecord[] {
  const latest = new Map<string, number>();
  for (const r of records) {
    const k = `${seriesBaseKey(r)}|${r.date}`;
    latest.set(k, Math.max(latest.get(k) ?? 0, r.ci.runAttempt));
  }
  return records.filter((r) => r.ci.runAttempt === latest.get(`${seriesBaseKey(r)}|${r.date}`));
}

/** Records -> series. Only one record per series per night is kept (the latest run attempt). */
export function buildSeries(allRecords: RunRecord[]): Series[] {
  const records = latestAttempts(allRecords);
  // Which base keys ever ran two clusters on the same night? Only records that name a cluster
  // count: a preset that aborted before any cluster ran has none.
  const perNight = new Map<string, Set<string>>();
  for (const r of records) {
    if (!r.cluster) continue;
    const k = `${seriesBaseKey(r)}|${r.date}`;
    (perNight.get(k) ?? perNight.set(k, new Set()).get(k)!).add(r.cluster);
  }
  const splitByCluster = new Map<string, Set<string>>();
  for (const [k, clusters] of perNight) {
    if (clusters.size < 2) continue;
    const base = k.slice(0, k.lastIndexOf("|"));
    const all = splitByCluster.get(base) ?? new Set<string>();
    for (const c of clusters) all.add(c);
    splitByCluster.set(base, all);
  }

  const groups = new Map<string, RunRecord[]>();
  const add = (id: string, r: RunRecord) => (groups.get(id) ?? groups.set(id, []).get(id)!).push(r);
  for (const r of records) {
    const base = seriesBaseKey(r);
    const clusters = splitByCluster.get(base);
    if (!clusters) add(base, r);
    // An abort with no cluster means the whole preset died that night: every cluster missed it.
    else if (!r.cluster) for (const c of clusters) add(`${base}|${c}`, r);
    else add(`${base}|${r.cluster}`, r);
  }

  const out: Series[] = [];
  for (const [id, rs] of groups) {
    const byDate = new Map<string, RunRecord>();
    for (const r of rs.sort((a, b) => a.ci.runAttempt - b.ci.runAttempt)) byDate.set(r.date, r);
    const dated = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
    const withResults = dated.filter(([, r]) => r.counts);
    const ran = withResults.map(([d]) => d);

    const errs = withResults.map(([, r]) => r.counts!.errored);
    const sizes = withResults.map(([, r]) => r.counts!.passed + r.counts!.failed + r.counts!.skipped + r.counts!.errored);
    const errMed = med(errs);
    const sizeMed = med(sizes);
    const truncated = withResults.filter((_, i) => sizes[i] < TRUNCATED_FRACTION * sizeMed).map(([d]) => d);
    const degraded = withResults
      .filter(([, r]) => r.counts!.errored >= DEGRADED_ERR_MIN && r.counts!.errored > DEGRADED_ERR_FACTOR * errMed)
      .map(([d]) => d);

    const first = rs[0];
    const params: Record<string, string | number | boolean> = {};
    for (const r of rs) Object.assign(params, r.params);
    out.push({
      id,
      preset: first.preset,
      kind: first.kind,
      suite: String(first.params.suite ?? first.kind),
      params,
      clusters: Object.fromEntries(dated.map(([d, r]) => [d, r.cluster])),
      passesKnown: rs.every((r) => r.passesKnown),
      ran,
      aborted: dated.filter(([, r]) => !r.counts).map(([d, r]) => ({ date: d, level: r.abortedAt, reason: r.abortReason })),
      degraded: [...new Set([...degraded, ...truncated])].sort(),
      truncated,
      nights: withResults.map(([d, r]) => ({ date: d, record: r, failing: failingTests(r) })),
    });
  }
  return out;
}

/**
 * Every test that failed at least once in the series, with its outcome on each night the
 * series ran. A truncated night is discarded outright (its named failures are aborted
 * classes, not outcomes); on a degraded night a named failure still counts but a silence is
 * unknown, as it is in a package whose failures the log only partly named. A JUnit record
 * names every outcome, so there a test is a pass only if it is listed as one; skipped, or not
 * in the results at all, is "not run" - never a pass, so never "stopped failing". A scraped
 * record names only failures, so there a silence is an inferred pass.
 *
 * A whole class that errored ("💥 DisconnectTest.", or a JUnit class-level error) gets its own
 * history under the bare class name - no method is invented: errored on those nights, and on
 * others a pass if any of its tests ran, not run if none did (JUnit), or an inferred pass.
 *
 * `include` names tests to give a history even if they never failed (the preset comparison
 * needs one for a scenario that failed only in the other preset).
 */
export function testHistories(series: Series, opts: { include?: Iterable<string> } = {}): Map<string, NightOutcome[]> {
  const truncated = new Set(series.truncated);
  const degraded = new Set(series.degraded);
  // A scraped night whose log hid failures in a package ("... and N more failure(s) in pkg")
  // can't vouch for any unnamed test in that package. Class -> package comes from the
  // JUnit-built records, which know it; a class never seen in one stays a (inferred) pass.
  const pkgOfClass = new Map<string, string>();
  for (const n of series.nights) for (const [cls, pkg] of Object.entries(n.record.packages ?? {})) pkgOfClass.set(cls, pkg);
  const hiddenOn = new Map(series.nights.filter((n) => n.record.hiddenFailures).map((n) => [n.date, n.record.hiddenFailures!]));
  const failing = new Map<string, Set<string>>();
  for (const n of series.nights) {
    if (truncated.has(n.date)) continue;
    for (const t of n.failing) (failing.get(t) ?? failing.set(t, new Set()).get(t)!).add(n.date);
    for (const [cls, o] of Object.entries(n.record.tests)) if (o.classError) (failing.get(cls) ?? failing.set(cls, new Set()).get(cls)!).add(n.date);
  }
  for (const t of opts.include ?? []) if (!failing.has(t)) failing.set(t, new Set());
  const recordOn = new Map(series.nights.map((n) => [n.date, n.record]));
  const out = new Map<string, NightOutcome[]>();
  for (const [test, dates] of failing) {
    const dot = test.indexOf(".");
    const wholeClass = dot < 0;
    const [cls, method] = wholeClass ? [test, ""] : [test.slice(0, dot), test.slice(dot + 1)];
    out.set(
      test,
      series.ran.map((d) => {
        const record = recordOn.get(d);
        if (dates.has(d)) return wholeClass || record?.tests[cls]?.e?.includes(method) ? "e" : "f";
        if (degraded.has(d)) return "u";
        if (record?.passesKnown) {
          const o = record.tests[cls];
          if (wholeClass) return o?.p?.length || o?.f?.length || o?.e?.length ? "p" : "n";
          return o?.p?.includes(method) ? "p" : "n";
        }
        const hidden = hiddenOn.get(d);
        const pkg = pkgOfClass.get(cls);
        return hidden && pkg && hidden[pkg] ? "u" : "p";
      }),
    );
  }
  return out;
}
