/**
 * Unit tests for run-record keys and outcome bookkeeping, and for when backfill
 * reprocesses a run.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/record/tests/run-record.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MANIFEST_SCHEMA, MAX_FETCH_ATTEMPTS, needsWork, type RunManifest } from "../run-manifest.js";
import { RUN_RECORD_SCHEMA, addOutcome, failingTests, recordKey, type ClassOutcomes, type RunRecord } from "../run-record.js";

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  schema: RUN_RECORD_SCHEMA,
  source: "run-log-scrape",
  sdk: "dotnet",
  preset: "op-capella-pe-sit-lite",
  kind: "situational",
  cluster: "Capella:8.0",
  params: {},
  date: "2026-09-27",
  ci: { repo: "couchbase/couchbase-net-client", runId: 36282119082, runAttempt: 1 },
  outcome: "passed",
  passesKnown: false,
  tests: {},
  ...over,
});

test("a record's key is deterministic and filesystem-safe", () => {
  assert.equal(
    recordKey(record()),
    "dotnet/records/2026/2026-09-27-36282119082-1-op-capella-pe-sit-lite.situational.Capella-8.0.json",
  );
  assert.equal(
    recordKey(record({ preset: "op-onprem-func-lite", kind: "functional", cluster: undefined })),
    "dotnet/records/2026/2026-09-27-36282119082-1-op-onprem-func-lite.functional.json",
  );
});

test("outcomes group by class, dedupe repeats, and keep a bare class as a class-level error", () => {
  const tests: Record<string, ClassOutcomes> = {};
  addOutcome(tests, "LockTest.getAndLock", "f");
  addOutcome(tests, "LockTest.getAndLock", "f"); // the same test under a second API
  addOutcome(tests, "LockTest.upsertLocked", "e");
  addOutcome(tests, "DisconnectTest.", "e");
  assert.deepEqual(tests, {
    LockTest: { f: ["getAndLock"], e: ["upsertLocked"] },
    DisconnectTest: { classError: true },
  });
  assert.deepEqual(failingTests(record({ tests })), ["LockTest.getAndLock", "LockTest.upsertLocked"]);
});

const manifest = (over: Partial<RunManifest>): RunManifest => ({
  schema: MANIFEST_SCHEMA,
  sdk: "dotnet",
  runId: 1,
  runAttempt: 1,
  date: "2026-09-27",
  status: "ok",
  records: [],
  ...over,
});

test("backfill processes a run with no manifest, and never re-does a finished one", () => {
  assert.equal(needsWork(undefined, "log-1"), true);
  assert.equal(needsWork(manifest({ status: "ok" }), "log-1"), false);
  assert.equal(needsWork(manifest({ status: "expired" }), "log-1"), false);
  assert.equal(needsWork(manifest({ status: "unsupported_era" }), "log-1"), false);
});

test("a parse error is retried only once the parser has changed", () => {
  assert.equal(needsWork(manifest({ status: "parse_error", parserVersion: "log-1" }), "log-1"), false);
  assert.equal(needsWork(manifest({ status: "parse_error", parserVersion: "log-1" }), "log-2"), true);
});

test("a failed fetch is retried up to the limit, then left alone", () => {
  assert.equal(needsWork(manifest({ status: "fetch_pending", fetchAttempts: 1 }), "log-1"), true);
  assert.equal(needsWork(manifest({ status: "fetch_pending", fetchAttempts: MAX_FETCH_ATTEMPTS }), "log-1"), false);
});

test("a reparse keeps a run's JUnit records only while their keys survive, and redoes the upgrade if not", async () => {
  const { reconcileUpgraded } = await import("../../backfill/ingest-log.js");
  const archive = { status: "ok" as const, upgraded: ["k/a", "k/b"], skipped: [], attempts: 1 };
  const same = reconcileUpgraded(archive, ["k/a", "k/b"]);
  assert.deepEqual([...same.keep], ["k/a", "k/b"]);
  assert.equal(same.archive, archive);
  // The parser moved k/b to k/c: the JUnit k/b is stale and the run must be upgraded again.
  const moved = reconcileUpgraded(archive, ["k/a", "k/c"]);
  assert.deepEqual([...moved.keep], ["k/a"]);
  assert.deepEqual(moved.drop, ["k/b"]);
  assert.equal(moved.archive, undefined);
});

test("the last failed fetch marks the run fetch_failed, not pending for ever", async () => {
  const { LocalHealthStore } = await import("../../store/health-store.js");
  const { recordFetchFailure } = await import("../../backfill/ingest-log.js");
  const root = mkdtempSync(join(tmpdir(), "fit-health-test-"));
  try {
    const store = new LocalHealthStore(root);
    const meta = { sdk: "dotnet", date: "2026-09-27", ci: { repo: "r", runId: 1, runAttempt: 1 } };
    let m: RunManifest | undefined;
    for (let i = 1; i <= MAX_FETCH_ATTEMPTS; i++) {
      m = recordFetchFailure(store, meta, false, "HTTP 502");
      assert.equal(m.status, i < MAX_FETCH_ATTEMPTS ? "fetch_pending" : "fetch_failed");
    }
    assert.equal(needsWork(m, "log-1"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reparse that fails keeps the run's records, rather than wiping a run an earlier parser read", async () => {
  const { LocalHealthStore } = await import("../../store/health-store.js");
  const { ingestLog } = await import("../../backfill/ingest-log.js");
  const root = mkdtempSync(join(tmpdir(), "fit-health-test-"));
  try {
    const store = new LocalHealthStore(root);
    const meta = { sdk: "dotnet", date: "2026-09-27", ci: { repo: "r", runId: 7, runAttempt: 1, job: "fit / op-onprem-func-lite" } };
    store.write("dotnet/records/2026/kept.json", "{}");
    store.writeManifest({ ...manifest({ runId: 7, records: ["dotnet/records/2026/kept.json"], parserVersion: "log-1" }), archive: { status: "ok", upgraded: ["dotnet/records/2026/kept.json"], skipped: [], attempts: 1 } });
    const m = ingestLog(store, meta, "some log no parser recognises", { keepRaw: false });
    assert.equal(m.status, "ok");
    assert.deepEqual(m.records, ["dotnet/records/2026/kept.json"]);
    assert.equal(m.parserVersion, "log-1", "still the old parser's, so the next one retries");
    assert.match(m.reparseError?.reason ?? "", /no FIT presets/);
    assert.ok(store.read("dotnet/records/2026/kept.json"), "the record is still there");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const LOG = join(import.meta.dirname, "../../log-parse/tests/fixtures/dotnet-2026-09-27.txt");

test("a reparse that no longer finds one of the run's presets keeps the run as it was", async () => {
  const { LocalHealthStore } = await import("../../store/health-store.js");
  const { ingestLog } = await import("../../backfill/ingest-log.js");
  const { buildRecords, parseRunLog } = await import("../../log-parse/parse-run-log.js");
  const root = mkdtempSync(join(tmpdir(), "fit-health-test-"));
  try {
    const store = new LocalHealthStore(root);
    const text = readFileSync(LOG, "utf8");
    const meta = { sdk: "dotnet", date: "2026-09-27", ci: { repo: "r", runId: 1, runAttempt: 1 } };
    const scraped = buildRecords(parseRunLog(text), meta).records;
    // A JUnit record for a preset the current parser doesn't find in the log - as if it had lost it.
    const lost = store.writeRecord({ ...scraped[0], source: "run-archive-junit", preset: "op-lost-func-lite" });
    const keys = [...scraped.map((r) => store.writeRecord(r)), lost];
    store.writeManifest({ ...manifest({ records: keys, parserVersion: "log-1" }), archive: { status: "ok", upgraded: [lost], skipped: [], attempts: 1 } });
    const m = ingestLog(store, meta, text, { keepRaw: false });
    assert.equal(m.status, "ok");
    assert.deepEqual(m.records, keys);
    assert.equal(m.parserVersion, "log-1", "still the old parser's, so the next one retries");
    assert.match(m.reparseError?.reason ?? "", /no longer finds op-lost-func-lite/);
    assert.deepEqual(m.archive?.upgraded, [lost], "check can still compare the JUnit record");
    assert.ok(store.read(lost), "the JUnit record is still there");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reparse that only moves a record to a new key replaces it", async () => {
  const { LocalHealthStore } = await import("../../store/health-store.js");
  const { ingestLog } = await import("../../backfill/ingest-log.js");
  const { buildRecords, parseRunLog } = await import("../../log-parse/parse-run-log.js");
  const root = mkdtempSync(join(tmpdir(), "fit-health-test-"));
  try {
    const store = new LocalHealthStore(root);
    const text = readFileSync(LOG, "utf8");
    const meta = { sdk: "dotnet", date: "2026-09-27", ci: { repo: "r", runId: 1, runAttempt: 1 } };
    const scraped = buildRecords(parseRunLog(text), meta).records;
    // The same preset, kind and cluster under an older key.
    const old = store.writeRecord({ ...scraped[0], variant: "old" });
    store.writeManifest(manifest({ records: [old, ...scraped.slice(1).map((r) => store.writeRecord(r))], parserVersion: "log-1" }));
    const m = ingestLog(store, meta, text, { keepRaw: false });
    assert.equal(m.reparseError, undefined);
    assert.deepEqual(m.records, scraped.map(recordKey));
    assert.equal(store.read(old), undefined, "the old key is gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
