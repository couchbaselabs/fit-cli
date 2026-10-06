/**
 * Unit tests for turning GitHub Actions run logs into fit health run records.
 *
 * The fixtures (.txt, since the repo ignores *.log) are real nightly logs cut down to the lines the parser reads (preset banners,
 * run headers, results tables, failure markers, fatal errors), one per log era:
 *   dotnet-2026-07-13  single `qe-set` preset, no banners; old red-name failure format
 *   dotnet-2026-08-05  op-multi-lite in ONE job, presets told apart only by banners
 *   dotnet-2026-09-27  a job per preset; ❌/💥 markers and an Err column
 *   dotnet-2026-07-31  a night that died in the harness before any test ran
 *   node-2026-09-27    class-level failures (`💥 DisconnectTest.`)
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/log-parse/tests/parse-run-log.test.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { failingTests, recordKey, type RunRecord } from "../../record/run-record.js";
import { assignVariants, buildRecords, parseRunLog, presetKind, readLogFile, stripAnsi } from "../parse-run-log.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

function records(fixture: string, date: string, sdk = "dotnet") {
  return buildRecords(parseRunLog(readLogFile(join(FIXTURES, fixture))), {
    sdk,
    date,
    ci: { repo: "couchbase/couchbase-net-client", runId: 1, runAttempt: 1 },
  });
}

const find = (rs: RunRecord[], preset: string, kind: string, cluster?: string) =>
  rs.find((r) => r.preset === preset && r.kind === kind && (cluster === undefined || r.cluster === cluster));

test("ANSI codes are stripped whether they arrive as escape bytes or as literal ^[", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
  assert.equal(stripAnsi("^[[31mred^[[0m"), "red");
});

test("a preset's test kind comes from its name", () => {
  assert.equal(presetKind("op-capella-pe-sit-lite"), "situational");
  assert.equal(presetKind("op-onprem-func-lite"), "functional");
  assert.equal(presetKind("qe-set"), undefined);
});

test("job-per-preset night: one record per preset, private endpoint told apart by its parameter", () => {
  const { records: rs, warnings, parseError } = records("dotnet-2026-09-27.txt", "2026-09-27");
  assert.equal(parseError, undefined);
  assert.deepEqual(warnings, []);
  assert.deepEqual(rs.map((r) => r.preset).sort(), [
    "op-capella-pe-sit-lite",
    "op-capella-sit-lite",
    "op-cng-func-lite",
    "op-onprem-func-lite",
  ]);
  // Both Capella presets print the identical tag; only the run parameter separates them.
  assert.equal(find(rs, "op-capella-sit-lite", "situational")!.params.privateEndpoint, false);
  assert.equal(find(rs, "op-capella-pe-sit-lite", "situational")!.params.privateEndpoint, true);
  assert.equal(find(rs, "op-capella-pe-sit-lite", "situational")!.cluster, "Capella:8.0");

  const onprem = find(rs, "op-onprem-func-lite", "functional")!;
  assert.equal(onprem.cluster, "8.5-stable");
  assert.equal(onprem.performer, "dotnet:main", "the run names its own SDK");
  assert.deepEqual(onprem.counts, { passed: 4040, skipped: 433, failed: 7, errored: 4 });
  assert.equal(onprem.outcome, "tests_failed");
  assert.equal(onprem.passesKnown, false);
  // 💥 is how transactions failures surface; matching only ❌ used to drop them.
  assert.ok(failingTests(onprem).some((t) => t.startsWith("CustomMetadataCollectionTest.")));
  assert.equal(find(rs, "op-cng-func-lite", "functional")!.params.gateway, "cng");
});

test("single-job night: presets are attributed from the banners, not the (identical) tag", () => {
  const { records: rs } = records("dotnet-2026-08-05.txt", "2026-08-05");
  assert.equal(find(rs, "op-capella-sit-lite", "situational")!.outcome, "passed");
  // The private-endpoint run started but never produced a results table.
  const pe = find(rs, "op-capella-pe-sit-lite", "situational")!;
  assert.equal(pe.outcome, "aborted");
  assert.equal(pe.counts, undefined);
  assert.equal(pe.params.privateEndpoint, true);
  assert.equal(find(rs, "op-cng-sit-lite", "situational")!.params.gateway, "cng");
});

test("old-format night: red names under Failures:, a table without an Err column, two clusters in one preset", () => {
  const { records: rs } = records("dotnet-2026-07-13.txt", "2026-07-13");
  const v80 = find(rs, "qe-set", "functional", "8.0-stable")!;
  const v76 = find(rs, "qe-set", "functional", "7.6-stable")!;
  assert.ok(v80 && v76, "each cluster of a multi-cluster preset is its own record");
  assert.equal(v80.counts!.errored, 0);
  assert.ok(failingTests(v80).length > 0);
  // The situational run's configuration must not leak onto the preset's functional runs.
  assert.equal(v80.params.privateEndpoint, undefined);
  assert.equal(find(rs, "qe-set", "situational")!.params.privateEndpoint, false);
});

test("situational results from before 2026-07-11 are skipped, not stored", () => {
  const { records: rs, warnings } = records("dotnet-2026-07-13.txt", "2026-07-10");
  assert.equal(find(rs, "qe-set", "situational"), undefined);
  assert.ok(warnings.some((w) => w.includes("situational results before")));
});

test("a night that died before any test ran becomes aborted records carrying fit-cli's classification", () => {
  const { records: rs, parseError } = records("dotnet-2026-07-31.txt", "2026-07-31");
  assert.equal(parseError, undefined);
  const onprem = find(rs, "op-onprem-func-lite", "functional")!;
  assert.equal(onprem.outcome, "aborted");
  assert.equal(onprem.abortedAt, "FatalToCluster");
  assert.match(onprem.abortReason!, /observability collector/);
  // A bare "FitCliError: ..." is an abort too, just an unclassified one.
  assert.equal(find(rs, "op-cng-sit-lite", "situational")!.abortedAt, "Unclassified");
});

test("class-level failures are kept as class errors, never guessed into a method", () => {
  const { records: rs } = records("node-2026-09-27.txt", "2026-09-27", "node");
  const cng = find(rs, "op-cng-func-lite", "functional")!;
  assert.equal(cng.tests.DisconnectTest?.classError, true);
});

test("a log with presets but nothing recognisable is a parse error, never a clean night", () => {
  const text = [
    "fit / op-onprem-func-lite\tRun\t2026-09-27T00:00:00.0Z [00:00:00] === Running preset 1/1: op-onprem-func-lite ===",
    "fit / op-onprem-func-lite\tRun\t2026-09-27T00:10:00.0Z some future output format",
  ].join("\n");
  const r = buildRecords(parseRunLog(text), { sdk: "dotnet", date: "2026-09-27", ci: { repo: "x", runId: 1, runAttempt: 1 } });
  assert.deepEqual(r.records, []);
  assert.match(r.parseError!, /no fit-cli result lines or fatal errors/);
});

test("a log naming no preset at all (an unknown format, or a workflow that died before fit-cli) is a parse error", () => {
  const ctx = { sdk: "dotnet", date: "2026-09-27", ci: { repo: "x", runId: 1, runAttempt: 1 } };
  for (const text of ["", "build / dotnet-build\tRun\t2026-09-27T00:00:00.0Z error: restore failed"]) {
    const r = buildRecords(parseRunLog(text), ctx);
    assert.deepEqual(r.records, []);
    assert.match(r.parseError!, /no FIT presets/);
  }
});

test("💥 is kept as errored and ❌ as failed, as JUnit would record them", () => {
  const { records: rs } = records("dotnet-2026-09-27.txt", "2026-09-27");
  const all = Object.assign({}, ...rs.map((r) => r.tests)) as RunRecord["tests"];
  assert.deepEqual(all.ExternalCollectionsTest?.e?.sort(), ["createCollectionWithSameNameAsExternalCollection", "getAllScopesFiltersOutExternalCollection"]);
  assert.equal(all.ExternalCollectionsTest?.f, undefined);
  assert.deepEqual(all.AppTelemetryE2ETest?.f, ["validateAllTypeRequestMetric"]);
  // Named under both markers (once per API, say): failed wins.
  const line = (marker: string) =>
    `fit / op-onprem-func-lite\tRun\t2026-09-27T00:01:00.0Z [00:01:00·1/1·aws1·8.0-stable·dotnet:main·functional]   ${marker} A.x`;
  const only = parseRunLog(line("💥"));
  assert.equal(only.runs.length, 1);
  assert.deepEqual([...only.runs[0].errored], ["A.x"]);
  const both = parseRunLog([line("💥"), line("❌")].join("\n"));
  assert.equal(both.runs.length, 1);
  assert.deepEqual([...both.runs[0].failing], ["A.x"]);
  assert.deepEqual([...both.runs[0].errored], []);
});

test("sanity checks: counted-but-unnamed and named-but-uncounted failures are not stored", () => {
  const tag = "[01:00:00·1/1·aws1·8.5-stable·dotnet:main·functional]";
  const line = (msg: string) => `fit / op-onprem-func-lite\tRun\t2026-09-27T01:00:00.0Z ${tag} ${msg}`;
  const table = (fail: number) => line(`TOTAL | 10 | 0 | ${fail} | 0 | 90.0% | 1:00`);
  const ctx = { sdk: "dotnet", date: "2026-09-27", ci: { repo: "x", runId: 1, runAttempt: 1 } };

  const unnamed = buildRecords(parseRunLog(table(2)), ctx);
  assert.deepEqual(unnamed.records, []);
  assert.match(unnamed.warnings[0], /counts 2 failures but none are named/);

  const uncounted = buildRecords(parseRunLog([line("  ❌ FooTest.bar"), table(0)].join("\n")), ctx);
  assert.deepEqual(uncounted.records, []);
  assert.match(uncounted.warnings[0], /named but the table counts none/);

  const ok = buildRecords(parseRunLog([line("  ❌ FooTest.bar"), table(1)].join("\n")), ctx);
  assert.deepEqual(failingTests(ok.records[0]), ["FooTest.bar"]);
});

test("failures fit-cli counted but did not name (its 3-per-package cap) are recorded per package", () => {
  const tag = "[01:00:00·1/1·aws1·8.0.2-5503·dotnet:main·functional:cng]";
  const line = (msg: string) => `fit / op-cng-func-lite\tRun\t2026-09-28T01:00:00.0Z ${tag} ${msg}`;
  const text = [
    line("  💥 LockTest.getAndLockTimeoutHasRetryReasonLocked"),
    line("  ^[[31m... and 2 more failure(s) in com.couchbase.client.kv^[[0m"),
    line("TOTAL | 10 | 0 | 0 | 3 | 70.0% | 1:00"),
  ].join("\n");
  const [r] = buildRecords(parseRunLog(text), { sdk: "dotnet", date: "2026-09-28", ci: { repo: "x", runId: 1, runAttempt: 1 } }).records;
  assert.deepEqual(r.hiddenFailures, { "com.couchbase.client.kv": 2 });
});

test("a single-preset night counts its preset as seen, so dying early is never a silent empty parse", () => {
  const ctx = { sdk: "dotnet", date: "2026-07-14", ci: { repo: "x", runId: 1, runAttempt: 1 } };
  const job = "run-dotnet-fit / run-fit-preset";
  // Nothing recognisable at all: a parse error, not "ok, 0 records".
  const unknown = buildRecords(parseRunLog(`${job}\tRun\t2026-07-14T00:27:00.0Z fit run preset "qe-set" --performer-image-name "dotnet-fit-performer:main"\n${job}\tRun\t2026-07-14T00:40:00.0Z some future output`), ctx);
  assert.match(unknown.parseError!, /qe-set/);
  // A group preset with banners is still attributed by its banners, not the group name.
  const group = parseRunLog(`${job}\tRun\t2026-08-05T00:27:00.0Z fit run preset "op-multi-lite" --performer-image-name "x"\n${job}\tRun\t2026-08-05T00:27:18.0Z [00:27:18] === Running preset 1/5: op-onprem-func-lite ===`);
  assert.deepEqual(group.presetsSeen, ["op-onprem-func-lite"]);
});

test("each job records when it cloned the driver, and any Gerrit patchset its preset pinned", () => {
  const ts = (t: string) => `2026-09-29T${t}.1234567Z`;
  const log = [
    `fit / op-onprem-func-lite\tUNKNOWN STEP\t${ts("00:20:45")} [00:20:45·aws1] Cloning transactions-fit-performer onto i-0ad9b7af0e5e...`,
    `fit / op-capella-sit-lite\tUNKNOWN STEP\t${ts("00:20:50")} [00:20:50·aws1] Cloning transactions-fit-performer onto i-033203d123b9...`,
    `fit / op-capella-sit-lite\tUNKNOWN STEP\t${ts("00:22:27")} [00:22:27·1/1·aws1·Capella:8.0·dotnet:main·situational:standard-qe]   FIT Gerrit ref: refs/changes/15/252815/3`,
    `fit / op-onprem-func-lite\tUNKNOWN STEP\t${ts("00:30:00")} [00:30:00·aws2] Cloning transactions-fit-performer (branch dk/x) onto i-0second...`,
  ].join("\n");
  assert.deepEqual(parseRunLog(log).driver, {
    "fit / op-onprem-func-lite": { clonedAt: "2026-09-29T00:20:45.123Z" },
    "fit / op-capella-sit-lite": { clonedAt: "2026-09-29T00:20:50.123Z", gerritRef: "refs/changes/15/252815/3" },
  });
  const branch = parseRunLog(`fit / x\tRun\t${ts("00:30:00")} [00:30:00·aws1] Cloning transactions-fit-performer (branch dk/x) onto i-0abc...`).driver;
  assert.deepEqual(branch, { "fit / x": { clonedAt: "2026-09-29T00:30:00.123Z", branch: "dk/x" } });
});

test("each job records the commit its performer image was built from", () => {
  const log = [
    "fit / op-onprem-func-lite\tUNKNOWN STEP\t2026-10-01T00:24:00.1Z [00:24:00·1/1·aws1·8.5-stable·dotnet:main·functional]   Revision     06cc170b0a50da4ec7df269b7b76f3434eed0fe8",
    "fit / op-cng-func-lite\tUNKNOWN STEP\t2026-10-01T00:24:01.1Z [00:24:01·1/1·aws1·8.0.2-5503·dotnet:main·functional:cng]   Revision     06cc170b0a50da4ec7df269b7b76f3434eed0fe8",
    "fit / op-onprem-func-lite\tUNKNOWN STEP\t2026-10-01T00:30:00.1Z [00:30:00·1/1·aws1·8.5-stable·dotnet:main·functional] INFO topology (revision 1.1922 -> 1.1925)",
  ].join("\n");
  assert.deepEqual(parseRunLog(log).performerRevision, {
    "fit / op-onprem-func-lite": "06cc170b0a50da4ec7df269b7b76f3434eed0fe8",
    "fit / op-cng-func-lite": "06cc170b0a50da4ec7df269b7b76f3434eed0fe8",
  });
});

test("records of one run that would share a key get a variant; the rest keep their key", () => {
  const rec = (suite: string, params: Record<string, string | number | boolean> = {}, preset = "op-capella-sit-release"): RunRecord => ({
    schema: 1,
    source: "run-log-scrape",
    sdk: "dotnet",
    preset,
    kind: "situational",
    cluster: "Capella:8.0",
    params: { suite, ...params },
    date: "2026-10-06",
    ci: { repo: "r", runId: 1, runAttempt: 1, job: "fit / x" },
    outcome: "passed",
    passesKnown: false,
    tests: {},
  });
  // Two suites on one cluster: the suite tells them apart.
  const bySuite = [rec("standard-qe"), rec("rebalance"), rec("standard-qe", {}, "op-onprem-func-lite")];
  assignVariants(bySuite);
  assert.deepEqual(bySuite.map((r) => r.variant), ["standard-qe", "rebalance", undefined]);
  assert.equal(new Set(bySuite.map(recordKey)).size, 3);
  assert.ok(!recordKey(bySuite[2]).includes("standard-qe"), "a record that doesn't collide keeps its old key");

  // The same suite with different parameters: a short, stable hash of them.
  const byParams = [rec("standard-qe", { privateEndpoint: true }), rec("standard-qe", { privateEndpoint: false })];
  assignVariants(byParams);
  assert.match(byParams[0].variant ?? "", /^[0-9a-f]{8}$/);
  assert.notEqual(byParams[0].variant, byParams[1].variant);
  const again = [rec("standard-qe", { privateEndpoint: true }), rec("standard-qe", { privateEndpoint: false })];
  assignVariants(again);
  assert.deepEqual(again.map((r) => r.variant), byParams.map((r) => r.variant), "deterministic, so backfill finds the same key");
});
