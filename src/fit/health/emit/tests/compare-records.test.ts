/**
 * Unit tests for building a record from JUnit outcomes and comparing it with the record
 * scraped from the same run's log.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/emit/tests/compare-records.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_RECORD_SCHEMA, type RunRecord } from "../../record/run-record.js";
import { recordFromJunit } from "../build-record.js";
import { junitOutcomes } from "../junit-outcomes.js";
import { compareRecords } from "../compare-records.js";

const scraped: RunRecord = {
  schema: RUN_RECORD_SCHEMA,
  source: "run-log-scrape",
  parserVersion: "log-2",
  sdk: "dotnet",
  preset: "op-onprem-func-lite",
  kind: "functional",
  cluster: "8.5-stable",
  params: { suite: "functional" },
  date: "2026-09-28",
  ci: { repo: "couchbase/couchbase-net-client", runId: 36361792614, runAttempt: 1, job: "fit / op-onprem-func-lite" },
  outcome: "tests_failed",
  counts: { passed: 1, failed: 1, errored: 0, skipped: 1 },
  passesKnown: false,
  tests: { LockTest: { f: ["getAndLock"] } },
};

const xml = (cases: string) => `<testsuite name="x">${cases}</testsuite>`;
const tc = (name: string, inner = "") =>
  inner ? `<testcase name="${name}" classname="com.couchbase.LockTest">${inner}</testcase>` : `<testcase name="${name}" classname="com.couchbase.LockTest"/>`;

test("a record built from JUnit is a fit-cli record that names passes, described like the scraped one", () => {
  const rec = recordFromJunit(junitOutcomes([xml(tc("getAndLock", "<failure/>") + tc("upsert") + tc("skipMe", "<skipped/>"))]), scraped);
  assert.equal(rec.source, "fit-cli");
  assert.equal(rec.passesKnown, true);
  assert.equal(rec.outcome, "tests_failed");
  assert.deepEqual(rec.tests, { LockTest: { f: ["getAndLock"], p: ["upsert"], s: ["skipMe"] } });
  assert.equal(rec.preset, scraped.preset);
});

test("agreement: the same failing tests and the same counts", () => {
  const rec = recordFromJunit(junitOutcomes([xml(tc("getAndLock", "<failure/>") + tc("upsert") + tc("skipMe", "<skipped/>"))]), scraped);
  const r = compareRecords(rec, scraped);
  assert.equal(r.agree, true);
  assert.equal(r.passesNamed, 1);
});

test("disagreement names the tests each side has alone, and the counts", () => {
  const rec = recordFromJunit(junitOutcomes([xml(tc("getAndLock") + tc("upsert", "<error/>"))]), scraped);
  const r = compareRecords(rec, scraped);
  assert.equal(r.agree, false);
  assert.deepEqual(r.onlyJunit, ["LockTest.upsert"]);
  assert.deepEqual(r.onlyLog, ["LockTest.getAndLock"]);
  assert.equal(r.countsAgree, false);
});


test("failures the log hid behind fit-cli's per-package cap are explained, not counted as disagreement", () => {
  const log: RunRecord = { ...scraped, counts: { passed: 0, failed: 0, errored: 3, skipped: 0 }, tests: { LockTest: { e: ["getAndLock"] } }, hiddenFailures: { "com.couchbase": 2 } };
  const rec = recordFromJunit(junitOutcomes([xml(tc("getAndLock", "<error/>") + tc("upsert", "<error/>") + tc("doubleLock", "<error/>"))]), log);
  const r = compareRecords(rec, log);
  assert.deepEqual(r.hiddenByCap, ["LockTest.doubleLock", "LockTest.upsert"]);
  assert.deepEqual(r.onlyJunit, []);
  assert.equal(r.agree, true);

  // ...but only as many as the log said it hid.
  const r2 = compareRecords(rec, { ...log, hiddenFailures: { "com.couchbase": 1 } });
  assert.equal(r2.agree, false);
});

test("a hidden failure is matched to its own class's package when two classes share a name", () => {
  // The driver has com.couchbase.client.observability.ObservabilityTest and
  // com.couchbase.transactions.observability.ObservabilityTest; the log prints both as
  // ObservabilityTest. gocb's 2026-10-05 nightly hid client's kvReplace behind the cap.
  const client = (name: string, inner = "") => `<testcase name="${name}" classname="com.couchbase.client.observability.ObservabilityTest">${inner}</testcase>`;
  const txn = (name: string) => `<testcase name="${name}" classname="com.couchbase.transactions.observability.ObservabilityTest"/>`;
  const log: RunRecord = {
    ...scraped,
    counts: { passed: 1, failed: 4, errored: 0, skipped: 0 },
    tests: { ObservabilityTest: { f: ["bucketFlush"] } },
    hiddenFailures: { "com.couchbase.client.observability": 1 },
  };
  const rec = recordFromJunit(
    junitOutcomes([xml(client("bucketFlush", "<failure/>").repeat(3) + client("kvReplace", "<failure/>") + txn("commit"))]),
    log,
  );
  const r = compareRecords(rec, log);
  assert.deepEqual(r.hiddenByCap, ["ObservabilityTest.kvReplace"]);
  assert.deepEqual(r.onlyJunit, []);
  assert.equal(r.agree, true);
});

test("classes that errored as a whole, hidden behind the cap, are explained too", () => {
  // couchbase-cxx-client's CNG nightly: every class errors before a test runs, and the log
  // names three per package, then "... and N more failure(s)" - the same cap as for tests.
  const cls = (pkg: string, name: string) => `<testcase name="" classname="com.couchbase.${pkg}.${name}"><error/></testcase>`;
  const log: RunRecord = {
    ...scraped,
    counts: { passed: 0, failed: 0, errored: 5, skipped: 0 },
    tests: { ATest: { classError: true }, BTest: { classError: true }, CTest: { classError: true }, XTest: { classError: true } },
    hiddenFailures: { "com.couchbase.kv": 1 },
  };
  const rec = recordFromJunit(junitOutcomes([xml(["ATest", "BTest", "CTest", "DTest"].map((n) => cls("kv", n)).join("") + cls("query", "XTest"))]), log);
  const r = compareRecords(rec, log);
  assert.deepEqual(r.hiddenByCap, ["DTest"]);
  assert.deepEqual(r.classErrorsOnlyJunit, []);
  assert.equal(r.agree, true);

  // One more missing than the log said it hid: a real disagreement, and named.
  const r2 = compareRecords(rec, { ...log, tests: { ATest: { classError: true }, BTest: { classError: true }, XTest: { classError: true } } });
  assert.equal(r2.agree, false);
  assert.deepEqual(r2.classErrorsOnlyJunit, ["CTest", "DTest"]);
});
