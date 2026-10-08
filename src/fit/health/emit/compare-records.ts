/**
 * Compare two records of the same run: one built from its full JUnit results, one scraped
 * from its CI log. They are independent measurements, so they must name the same failing
 * tests and the JUnit counts must match the log's results table - except for failures the
 * log hid behind fit-cli's per-package display cap, which are expected and reported apart.
 *
 * `fit health check` runs this on each SDK's most recent nights to confirm the log parser
 * reads that SDK's output correctly.
 */
import { failingTests, type RunRecord } from "../record/run-record.js";

export interface RecordComparison {
  label: string;
  agree: boolean;
  /** Failing in JUnit but not named in the log, and the reverse. */
  onlyJunit: string[];
  /**
   * The failures - tests, and classes that errored as a whole - accounted for by fit-cli's
   * per-package display cap: the log said "... and N more failure(s) in <package>" for their
   * package, with N at least as many as are missing. Expected, not a reader bug - but it means log-scraped history
   * undercounts failures on such nights.
   */
  hiddenByCap: string[];
  onlyLog: string[];
  countsJunit?: RunRecord["counts"];
  countsLog?: RunRecord["counts"];
  countsAgree: boolean;
  /**
   * Class-level errors one side has alone, after those hidden by the cap (which are in
   * hiddenByCap). The log keeps them apart from tests, so they are compared separately.
   */
  classErrorsOnlyJunit: string[];
  classErrorsOnlyLog: string[];
}

const classErrors = (r: RunRecord) => Object.entries(r.tests).filter(([, o]) => o.classError).map(([c]) => c).sort();

/**
 * A test id as fit-cli's log prints it: the simple class name. JUnit ids qualify a class name
 * the driver reuses across packages ("kv/GetTest.x"); the log can't, so they are compared plain.
 */
export const asLogged = (id: string) => id.replace(/^[^.]*\//, "");

export function compareRecords(junit: RunRecord, scraped: RunRecord): RecordComparison {
  const j = new Set(failingTests(junit).map(asLogged));
  const l = new Set(failingTests(scraped));
  const missing = [...j].filter((t) => !l.has(t)).sort();
  // Class-level errors, by the name the log prints (a reused class name is one name there).
  const cj = [...new Set(classErrors(junit).map(asLogged))].sort();
  const clog = classErrors(scraped);
  const missingClasses = cj.filter((c) => !clog.includes(c));
  const hidden = scraped.hiddenFailures ?? {};
  // Each failure's package comes from its own class. Keyed by the logged name, classes the
  // driver reuses across packages (client/observability/ObservabilityTest and
  // transactions/observability/ObservabilityTest) would collapse into one, and a failure could
  // be given the other class's package - so a logged name can have more than one package.
  const pkgsOf = new Map<string, Set<string>>();
  const addPkg = (cls: string, logged: string) => {
    const p = junit.packages?.[cls];
    if (p) (pkgsOf.get(logged) ?? pkgsOf.set(logged, new Set()).get(logged)!).add(p);
  };
  for (const t of failingTests(junit)) addPkg(t.slice(0, t.indexOf(".")), asLogged(t));
  for (const c of classErrors(junit)) addPkg(c, asLogged(c));
  // The cap counts a class error like a failing test: both are a failure line it didn't print.
  const unnamed = [...missing, ...missingClasses];
  const byPkg = new Map<string, string[]>();
  for (const t of unnamed) {
    for (const p of pkgsOf.get(t) ?? []) (byPkg.get(p) ?? byPkg.set(p, []).get(p)!).push(t);
  }
  // Hidden only if the log hid at least as many failures as are missing in every package the
  // failure could be in.
  const hiddenByCap = unnamed
    .filter((t) => {
      const ps = [...(pkgsOf.get(t) ?? [])];
      return ps.length > 0 && ps.every((p) => (hidden[p] ?? 0) >= byPkg.get(p)!.length);
    })
    .sort();
  const onlyJunit = missing.filter((t) => !hiddenByCap.includes(t));
  const onlyLog = [...l].filter((t) => !j.has(t)).sort();
  const classErrorsOnlyJunit = missingClasses.filter((c) => !hiddenByCap.includes(c));
  const classErrorsOnlyLog = clog.filter((c) => !cj.includes(c));
  const ce = junit.counts;
  const cl = scraped.counts;
  const countsAgree = !!ce && !!cl && ce.passed === cl.passed && ce.failed === cl.failed && ce.errored === cl.errored && ce.skipped === cl.skipped;
  return {
    label: `${scraped.date} ${scraped.preset} ${scraped.kind}${scraped.cluster ? ` @${scraped.cluster}` : ""}`,
    agree: onlyJunit.length === 0 && onlyLog.length === 0 && countsAgree && classErrorsOnlyJunit.length === 0 && classErrorsOnlyLog.length === 0,
    onlyJunit,
    hiddenByCap,
    onlyLog,
    countsJunit: ce,
    countsLog: cl,
    countsAgree,
    classErrorsOnlyJunit,
    classErrorsOnlyLog,
  };
}
