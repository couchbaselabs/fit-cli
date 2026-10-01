/**
 * Compare two records of the same run: one built from its full JUnit results, one scraped
 * from its CI log. They are independent measurements, so they must name the same failing
 * tests and the JUnit counts must match the log's results table - except for failures the
 * log hid behind fit-cli's per-package display cap, which are expected and reported apart.
 *
 * `fit health check` runs this on each SDK's most recent nights to confirm the log parser
 * reads that SDK's output correctly.
 */
import { failingTests, recordKey, type RunRecord } from "../record/run-record.js";

export interface RecordComparison {
  key: string;
  label: string;
  agree: boolean;
  /** Failing in JUnit but not named in the log, and the reverse. */
  onlyJunit: string[];
  /**
   * The part of onlyJunit accounted for by fit-cli's per-package display cap: the log said
   * "... and N more failure(s) in <package>" for these tests' package, with N at least as
   * many as are missing. Expected, not a reader bug - but it means log-scraped history
   * undercounts failures on such nights.
   */
  hiddenByCap: string[];
  onlyLog: string[];
  countsJunit?: RunRecord["counts"];
  countsLog?: RunRecord["counts"];
  countsAgree: boolean;
  /** Class-level errors: the log keeps them apart from tests, so they are compared separately. */
  classErrorsJunit: string[];
  classErrorsLog: string[];
  passesNamed: number;
}

const classErrors = (r: RunRecord) => Object.entries(r.tests).filter(([, o]) => o.classError).map(([c]) => c).sort();

/**
 * A test id as fit-cli's log prints it: the simple class name. JUnit ids qualify a class name
 * the driver reuses across packages ("kv/GetTest.x"); the log can't, so they are compared plain.
 */
export const asLogged = (id: string) => id.replace(/^[^.]*\//, "");

export function compareRecords(emitted: RunRecord, scraped: RunRecord): RecordComparison {
  const j = new Set(failingTests(emitted).map(asLogged));
  const l = new Set(failingTests(scraped));
  const missing = [...j].filter((t) => !l.has(t)).sort();
  const hidden = scraped.hiddenFailures ?? {};
  const packages = Object.fromEntries(Object.entries(emitted.packages ?? {}).map(([c, p]) => [asLogged(c), p]));
  const pkgOf = (t: string) => packages[t.slice(0, t.indexOf("."))];
  const byPkg = new Map<string, string[]>();
  for (const t of missing) {
    const p = pkgOf(t);
    if (p) (byPkg.get(p) ?? byPkg.set(p, []).get(p)!).push(t);
  }
  const hiddenByCap = [...byPkg.entries()].filter(([p, ts]) => (hidden[p] ?? 0) >= ts.length).flatMap(([, ts]) => ts).sort();
  const onlyJunit = missing.filter((t) => !hiddenByCap.includes(t));
  const onlyLog = [...l].filter((t) => !j.has(t)).sort();
  const ce = emitted.counts;
  const cl = scraped.counts;
  const countsAgree = !!ce && !!cl && ce.passed === cl.passed && ce.failed === cl.failed && ce.errored === cl.errored && ce.skipped === cl.skipped;
  const cj = classErrors(emitted).map(asLogged).sort();
  const clog = classErrors(scraped);
  return {
    key: recordKey(scraped),
    label: `${scraped.date} ${scraped.preset} ${scraped.kind}${scraped.cluster ? ` @${scraped.cluster}` : ""}`,
    agree: onlyJunit.length === 0 && onlyLog.length === 0 && countsAgree && cj.join() === clog.join(),
    onlyJunit,
    hiddenByCap,
    onlyLog,
    countsJunit: ce,
    countsLog: cl,
    countsAgree,
    classErrorsJunit: cj,
    classErrorsLog: clog,
    passesNamed: Object.values(emitted.tests).reduce((a, o) => a + (o.p?.length ?? 0), 0),
  };
}
