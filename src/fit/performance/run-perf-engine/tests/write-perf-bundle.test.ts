import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPerfRunRecord, shouldRecordRun } from "../write-perf-bundle.js";
import { curlArgs, parseRestResponse, storageBackend, unhealthyNodes } from "../perf-cluster-rest.js";
import { classifyResult, largestPoolPerPreface, mergeSettings } from "../run-perf-engine.js";
import type { PerfTestSuite } from "../../run-perf-driver/run-perf-driver.js";
import type { PerfOperation } from "../build-perf-request.js";
import { planResultsUpload } from "../../../situational/upload-results/upload-results.js";
import { parseBucketsCsv, parseMetricsCsv, parseRunJson5 } from "../../../ingest/parse.js";
import { BUCKETS_CSV_HEADER, formatBucketRow, isoSecond, summariseBucket } from "../perf-buckets.js";
import { METRICS_CSV_HEADER } from "../write-perf-bundle.js";
import { bundleDirName } from "../../run-perf-driver/run-perf-driver.js";

const testSuite: PerfTestSuite = {
  impl: { language: "Java", version: "main", image: { revision: "abc123", created: "2026-08-06T15:03:20.363Z" } },
  connections: {
    cluster: {
      connection_string_driver: "couchbase://127.0.0.1",
      connection_string_performer: "couchbase://127.0.0.1",
      hostname_rest: "http://127.0.0.1:8091",
      type: "unmanaged",
      version: "7.6.2",
      nodeCount: 1,
      storage: "couchstore",
      replicas: 0,
      memory: 1024,
    },
    performer: { hostname: "localhost", hostname_docker: "localhost", port: 8060 },
  },
  runs: [
    {
      uuid: "112feeeb-8826-437a-ac88-b9f6a2affb73",
      operations: [{ op: "get", bounds: { forSeconds: "$forSeconds" }, docLocation: { method: "pool", poolSize: "$poolSize" } }],
    },
  ],
  settings: {
    variables: [
      { name: "horizontalScaling", value: 1 },
      { name: "forSeconds", value: 20 },
      { name: "poolSize", value: 1000 },
    ],
    driverVer: 6,
    performerVer: 1,
  },
  files: { outputDirectory: "results" },
};

test("run.json5 carries the four params keys the perf UI and dedup query read", () => {
  const record = buildPerfRunRecord(testSuite, 0);
  assert.equal(record.runUuid, "112feeeb-8826-437a-ac88-b9f6a2affb73");
  assert.deepEqual(Object.keys(record.forDatabase).sort(), ["cluster", "impl", "vars", "workload"]);
});

test("a suite with a runner records it, beside the four keys and without changing them", () => {
  const runner = { name: "fit-cli", commit: "0123456789abcdef0123456789abcdef01234567" } as const;
  const plain = buildPerfRunRecord(testSuite, 0).forDatabase;
  const marked = buildPerfRunRecord({ ...testSuite, runner }, 0).forDatabase;
  assert.deepEqual(marked.runner, runner);
  assert.deepEqual(Object.keys(marked).sort(), ["cluster", "impl", "runner", "vars", "workload"]);
  const { runner: _runner, ...rest } = marked;
  assert.deepEqual(rest, plain);
});

test("the run uuid is the row's key and stays out of params", () => {
  const record = buildPerfRunRecord(testSuite, 0);
  assert.equal("uuid" in record.forDatabase.workload, false);
});

test("connection details are stripped from the cluster block, except the one that is kept", () => {
  const cluster = buildPerfRunRecord(testSuite, 0).forDatabase.cluster;
  assert.equal("connection_string_driver" in cluster, false);
  assert.equal("connection_string_performer" in cluster, false);
  // The performer's connection string is re-added under the name the database uses.
  assert.equal(cluster.connectionString, "couchbase://127.0.0.1");
  // hostname_rest is deliberately not stripped: it is in the recorded history, and dropping it
  // would change what matches. See O8 in working/fit-perf-decisions.md.
  assert.equal(cluster.hostname_rest, "http://127.0.0.1:8091");
});

test("variables are split out into vars, with the driver and performer versions", () => {
  const vars = buildPerfRunRecord(testSuite, 0).forDatabase.vars;
  assert.deepEqual(vars, { horizontalScaling: 1, forSeconds: 20, poolSize: 1000, driverVer: 6, performerVer: 1 });
});

test("the workload keeps its unresolved $variable references", () => {
  // It is stored verbatim and is part of the datapoint's identity, so resolving the
  // references here would split a workload away from its own history.
  const workload = buildPerfRunRecord(testSuite, 0).forDatabase.workload as { operations: { bounds: { forSeconds: string } }[] };
  assert.equal(workload.operations[0].bounds.forSeconds, "$forSeconds");
});

test("a ping-only run is not recorded", () => {
  assert.equal(shouldRecordRun([{ op: "get" }]), true);
  assert.equal(shouldRecordRun([{ op: "ping" }]), false);
  assert.equal(shouldRecordRun([{ op: "get" }, { op: "ping" }]), false);
});

test("mergeSettings flattens the variable list and picks out tunables", () => {
  const merged = mergeSettings(testSuite, 0);
  assert.deepEqual(merged.variables, { horizontalScaling: 1, forSeconds: 20, poolSize: 1000 });
  assert.deepEqual(merged.tunableNames, []);
});

test("mergeSettings lets per-run variables override the top-level ones", () => {
  const withRunSettings: PerfTestSuite = {
    ...testSuite,
    runs: [{ ...testSuite.runs[0], settings: { variables: [{ name: "forSeconds", value: 5 }] } }],
  };
  assert.equal(mergeSettings(withRunSettings, 0).variables.forSeconds, 5);
});

test("only the largest pool per id-preface is created", () => {
  const operations: PerfOperation[] = [
    { op: "get", docLocation: { method: "pool", poolSize: 1000, poolSelectionStrategy: "randomUniform" } },
    { op: "replace", docLocation: { method: "pool", poolSize: 10_000, poolSelectionStrategy: "randomUniform" } },
    { op: "insert", docLocation: { method: "pool", idPreface: "other_", poolSize: 50, poolSelectionStrategy: "randomUniform" } },
  ];
  const pools = largestPoolPerPreface({ variables: {} }, operations);
  assert.deepEqual([...pools.entries()].sort(), [["doc_", 10_000], ["other_", 50]]);
});

test("pools inside transactions are created too", () => {
  const operations: PerfOperation[] = [
    { transaction: { ops: [{ op: "get", docLocation: { method: "pool", poolSize: 7, poolSelectionStrategy: "counter" } }] } },
  ];
  assert.deepEqual([...largestPoolPerPreface({ variables: {} }, operations).entries()], [["doc_", 7]]);
});

test("a result with no initiated timestamp cannot be bucketed", () => {
  assert.equal(
    classifyResult({
      $typeName: "protocol.run.Result",
      elapsedNanos: 100n,
      result: { case: "sdk", value: { $typeName: "protocol.sdk.Result", result: { case: "success", value: true } } },
    }),
    undefined,
  );
});

test("an sdk result that isn't an explicit success counts as a failure, as it does in Java", () => {
  const sample = classifyResult({
    $typeName: "protocol.run.Result",
    elapsedNanos: 100n,
    initiated: { $typeName: "google.protobuf.Timestamp", seconds: 7n, nanos: 0 },
    result: { case: "sdk", value: { $typeName: "protocol.sdk.Result", result: { case: "nullResult", value: true } } },
  });
  assert.equal(sample?.success, false);
  assert.equal(sample?.bucketSec, 7);
});

test("an explicit sdk success is a success", () => {
  const sample = classifyResult({
    $typeName: "protocol.run.Result",
    elapsedNanos: 100n,
    initiated: { $typeName: "google.protobuf.Timestamp", seconds: 7n, nanos: 0 },
    result: { case: "sdk", value: { $typeName: "protocol.sdk.Result", result: { case: "success", value: true } } },
  });
  assert.equal(sample?.success, true);
  assert.equal(sample?.elapsedNanos, 100);
});

test("curlArgs builds a form-encoded management call with the status appended", () => {
  const args = curlArgs({ restHost: "http://h:8091", username: "u", password: "p" }, "POST", "/pools/default/buckets", { name: "default", ramQuota: 1024 });
  assert.ok(args.includes("--insecure"));
  assert.ok(args.includes("http://h:8091/pools/default/buckets"));
  assert.deepEqual(args.slice(args.indexOf("-d")), ["-d", "name=default", "-d", "ramQuota=1024"]);
});

test("parseRestResponse splits the body from the trailing status line", () => {
  assert.deepEqual(parseRestResponse('{"ok":true}\n200'), { status: 200, body: '{"ok":true}' });
  // A body containing newlines still parses, because only the last line is the status.
  assert.deepEqual(parseRestResponse("line1\nline2\n404"), { status: 404, body: "line1\nline2" });
  assert.deepEqual(parseRestResponse("202"), { status: 202, body: "" });
});

test("unhealthyNodes names the nodes that aren't ready", () => {
  assert.deepEqual(unhealthyNodes('{"nodes":[{"hostname":"a:8091","status":"healthy"}]}'), []);
  assert.deepEqual(unhealthyNodes('{"nodes":[{"hostname":"a:8091","status":"warmup"}]}'), ["a:8091"]);
  // An unparseable body is not "healthy" — it means we couldn't tell.
  assert.equal(unhealthyNodes("not json").length, 1);
});

test("storageBackend only recognises magma by name", () => {
  assert.equal(storageBackend("magma"), "magma");
  assert.equal(storageBackend("MAGMA"), "magma");
  assert.equal(storageBackend("couchstore"), "couchstore");
  assert.equal(storageBackend(undefined), "couchstore");
});

test("a perf run.json5 plans for upload under the invocation's id, despite its top-level runUuid", () => {
  const record = buildPerfRunRecord(testSuite, 0);
  const groupId = "11111111-2222-4333-8444-555555555555";
  const plan = planResultsUpload([{ dirName: bundleDirName(record.runUuid), runJson5: JSON.stringify(record) }], { fallbackId: groupId });
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.uploads.map((u) => u.keyPrefix), [`incoming/${groupId}/${record.runUuid}`]);
});

test("the ingest reads a perf run.json5 as a performance run, with the uuid kept out of params", () => {
  const record = buildPerfRunRecord(testSuite, 0);
  const parsed = parseRunJson5(JSON.stringify(record));
  assert.equal(parsed.kind, "performance");
  assert.equal(parsed.runUuid, record.runUuid);
  assert.deepEqual(Object.keys(parsed.params).sort(), ["cluster", "impl", "vars", "workload"]);
});

test("the ingest accepts the buckets.csv the engine writes, with and without errors", () => {
  const clean = summariseBucket(100, 100, [
    { bucketSec: 100, success: true, elapsedNanos: 1_234_567 },
    { bucketSec: 100, success: true, elapsedNanos: 2_000_001 },
    { bucketSec: 100, success: true, elapsedNanos: 3_333_333 },
  ]);
  const withErrors = summariseBucket(100, 101, [
    { bucketSec: 101, success: true, elapsedNanos: 999 },
    { bucketSec: 101, success: false, elapsedNanos: 0, errorName: "TimeoutException" },
  ]);
  const csv = [BUCKETS_CSV_HEADER, formatBucketRow(clean), formatBucketRow(withErrors)].join("\n") + "\n";
  const rows = parseBucketsCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.errors, null);
  assert.deepEqual(JSON.parse(rows[1]?.errors ?? "{}"), { TimeoutException: 1 });
  assert.equal(rows[1]?.timeOffsetSecs, 1);
});

test("the ingest accepts the metrics.csv the engine writes", () => {
  const csv = `${METRICS_CSV_HEADER}\n${[isoSecond(100), 3, '"{""cpu"":12.5}"'].join(",")}\n`;
  assert.deepEqual(parseMetricsCsv(csv).map((r) => r.metrics), ['{"cpu":12.5}']);
});
