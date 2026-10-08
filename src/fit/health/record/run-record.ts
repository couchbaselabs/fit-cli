/**
 * The run record: raw observations from one fit-cli run (one cluster × one SDK × one
 * test type, inside one preset) of one CI job. `fit health` derives everything else -
 * chronic, flaky, trends - from these at report time, so the rules can change without
 * rewriting history.
 *
 * Two sources write the same shape:
 *   - "run-archive-junit": backfilled from the JUnit results in the run's S3 archive. Every
 *                       outcome, passes included.
 *   - "run-log-scrape": backfilled from a GitHub Actions log. Only failures are named there -
 *                       and at most 3 per package, see hiddenFailures - so `passesKnown` is false
 *                       and an unlisted test's pass is only inferred.
 */

export const RUN_RECORD_SCHEMA = 1 as const;

export type RecordSource = "run-archive-junit" | "run-log-scrape";

/**
 * How the run ended.
 *   passed        every test passed
 *   tests_failed  the test-driver ran to completion and some tests did not pass
 *   aborted       the run started but no results table was produced (harness, cluster, box)
 */
export type RunOutcome = "passed" | "tests_failed" | "aborted";

export type TestKind = "functional" | "situational";

export interface ResultCounts {
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
}

/**
 * Tests grouped by class. `p`/`f`/`e`/`s` are method names that passed / failed (assertion) /
 * errored / were skipped. `classError` marks a whole class that aborted without naming a
 * method (e.g. `💥 DisconnectTest.`). A scraped record only ever fills `f` and `e`.
 */
export interface ClassOutcomes {
  p?: string[];
  f?: string[];
  e?: string[];
  s?: string[];
  classError?: boolean;
}

export interface CiContext {
  repo: string;
  workflow?: string;
  ref?: string;
  sha?: string;
  event?: string;
  runId: number;
  runAttempt: number;
  job?: string;
}

export interface RunRecord {
  schema: typeof RUN_RECORD_SCHEMA;
  source: RecordSource;
  /** Set for scraped records: which log parser produced it. */
  parserVersion?: string;
  sdk: string;
  /** The preset this run belonged to, e.g. op-capella-pe-sit-lite. */
  preset: string;
  /**
   * The performer the run tested, as fit-cli tags it: "<sdk>:<image tag>", e.g. "java:main".
   * The SDK half is how a run identifies its own SDK - backfill checks it against the opt-in.
   */
  performer?: string;
  kind: TestKind;
  /**
   * The run's cluster as fit-cli labels it: a server version alias ("8.5-stable") or a
   * deployment ("Capella:8.0"). Undefined when the log did not say.
   */
  cluster?: string;
  /**
   * Run parameters that distinguish otherwise identical runs - e.g. privateEndpoint. Presets
   * that print the same tag (op-capella-sit-lite vs op-capella-pe-sit-lite) differ only here,
   * so these must never be merged.
   */
  params: Record<string, string | number | boolean>;
  /** The UTC date of the CI run (YYYY-MM-DD). */
  date: string;
  ci: CiContext;
  outcome: RunOutcome;
  /**
   * For an aborted run: fit-cli's failure classification (FatalToInstance, FatalToCluster, ...)
   * and its message. This is the harness-vs-SDK signal: a run that never reached its tests
   * says nothing about the SDK.
   */
  abortedAt?: string;
  abortReason?: string;
  /** Undefined when there was no results table (an aborted run). */
  counts?: ResultCounts;
  /**
   * Scraped records only: failures the log counted but did not name, per Java package.
   * fit-cli's console output shows at most 3 failures per package and then prints
   * "... and N more failure(s) in <package>", so on such a night an unnamed test in that
   * package may have failed. Emitted records name every failure and never set this.
   */
  hiddenFailures?: Record<string, number>;
  /** For "run-archive-junit": where the JUnit results were read from. */
  archive?: { uri: string; member: string };
  /** Emitted records: each test class's Java package, which log output never shows. */
  packages?: Record<string, string>;
  /**
   * Set only when one run produced two records with the same preset, kind and cluster (two
   * suites, or the same suite with different parameters): it tells them apart in the record
   * key and the series. Absent otherwise, so no existing record's key changes.
   */
  variant?: string;
  /** False for scraped records: absence from `tests` does not mean the test passed. */
  passesKnown: boolean;
  tests: Record<string, ClassOutcomes>;
}

/** A short, filesystem-safe identifier for the run within its CI job. */
export function recordSlug(record: Pick<RunRecord, "preset" | "kind" | "cluster" | "variant">): string {
  const parts = [record.preset, record.kind, record.cluster, record.variant].filter((p): p is string => !!p);
  return parts.join(".").replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** Where a record lives, relative to the store root. Deterministic, which is what backfill relies on. */
export function recordKey(record: RunRecord): string {
  const year = record.date.slice(0, 4);
  return `${record.sdk}/records/${year}/${record.date}-${record.ci.runId}-${record.ci.runAttempt}-${recordSlug(record)}.json`;
}

/** Every test the record names as not passing (failed or errored), as `Class.method`. */
export function failingTests(record: RunRecord): string[] {
  const out: string[] = [];
  for (const [cls, o] of Object.entries(record.tests)) {
    for (const m of [...(o.f ?? []), ...(o.e ?? [])]) out.push(`${cls}.${m}`);
  }
  return [...new Set(out)].sort();
}

/**
 * Add one named outcome to a record's tests. Accepts `Class.method`, or `Class.` for a
 * class-level abort. A name without a dot is kept as a class-level abort rather than
 * guessed into a method.
 */
export function addOutcome(tests: Record<string, ClassOutcomes>, name: string, outcome: "p" | "f" | "e" | "s"): void {
  const dot = name.indexOf(".");
  const cls = dot < 0 ? name : name.slice(0, dot);
  const method = dot < 0 ? "" : name.slice(dot + 1);
  const entry = (tests[cls] ??= {});
  if (!method) {
    entry.classError = true;
    return;
  }
  const list = (entry[outcome] ??= []);
  if (!list.includes(method)) list.push(method);
}
