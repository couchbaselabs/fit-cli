import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PERF_HORIZONTAL_SCALING,
  DEFAULT_PERF_REPLICAS,
  DEFAULT_PERF_STORAGE,
  assessPerfBundles,
  buildPerfTestSuite,
  countCsvDataRows,
  describePerfWorkload,
  fitCliRunner,
  perfImplBlock,
  restHostname,
} from "../run-perf-driver.js";
import { PERF_WORKLOADS, perfWorkloadByValue } from "../perf-workloads.js";
import { writePerfSkipMarker } from "../../run-perf-engine/write-perf-bundle.js";
import type { SelectedCluster } from "../../../../cluster/cluster-select/cluster-select.js";
import type { PerformanceSection } from "../../../shared/definition/types.js";
import { sdkByValue, type Sdk } from "../../../../util/sdk/sdks.js";

function requireSdk(value: string): Sdk {
  const sdk = sdkByValue(value);
  if (!sdk) {
    throw new Error(`Expected the ${value} SDK to exist.`);
  }
  return sdk;
}

const java = requireSdk("java");
const cpp = requireSdk("cpp");

const cluster: SelectedCluster = {
  scheme: "couchbase",
  defaultHostname: "10.0.0.1",
  flavour: "self-managed",
  credentials: { username: "Administrator", password: "password" },
  tls: null,
};

const getWorkload: PerformanceSection = {
  workload: {
    operations: [
      {
        op: "get",
        bounds: { forSeconds: "$forSeconds" },
        docLocation: { method: "pool", poolSize: "$poolSize", poolSelectionStrategy: "randomUniform" },
      },
    ],
  },
  variables: { forSeconds: 300, poolSize: 10000 },
};

function suite(overrides: Partial<Parameters<typeof buildPerfTestSuite>[0]> = {}) {
  return buildPerfTestSuite({
    sdk: java,
    performerVersion: "main",
    cluster,
    performerHost: "localhost",
    performerPort: 8060,
    performance: getWorkload,
    runUuid: "11111111-2222-3333-4444-555555555555",
    outputDirectory: "perf-driver/results",
    ...overrides,
  });
}

test("carries the workload operations through verbatim", () => {
  // The workload is a datapoint's identity and is stored as-is in runs.params —
  // any rewriting here would split a workload from its own history.
  assert.deepEqual(suite().runs[0]?.operations, getWorkload.workload.operations);
});

test("emits one run, keyed by the supplied uuid", () => {
  const built = suite();
  assert.equal(built.runs.length, 1);
  assert.equal(built.runs[0]?.uuid, "11111111-2222-3333-4444-555555555555");
});

test("always supplies horizontalScaling, which the driver reads unconditionally", () => {
  const variables = suite({ performance: { workload: getWorkload.workload } }).settings.variables;
  assert.deepEqual(variables, [{ name: "horizontalScaling", value: DEFAULT_PERF_HORIZONTAL_SCALING }]);
});

test("lets the definition override horizontalScaling", () => {
  const built = suite({ performance: { ...getWorkload, variables: { ...getWorkload.variables, horizontalScaling: 20 } } });
  const scaling = built.settings.variables.find((v) => v.name === "horizontalScaling");
  assert.equal(scaling?.value, 20);
});

test("converts the variables map to the driver's name/value list", () => {
  assert.deepEqual(
    suite().settings.variables.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "forSeconds", value: 300 },
      { name: "horizontalScaling", value: 1 },
      { name: "poolSize", value: 10000 },
    ],
  );
});

test("defaults the cluster facts the driver acts on when creating the bucket", () => {
  const built = suite();
  assert.equal(built.connections.cluster.replicas, DEFAULT_PERF_REPLICAS);
  assert.equal(built.connections.cluster.storage, DEFAULT_PERF_STORAGE);
});

test("omits pure metadata rather than guessing it", () => {
  // A wrong cpuCount silently compares a run against history it isn't comparable
  // with, so an unknown value is left out entirely.
  const built = suite();
  assert.equal("cpuCount" in built.connections.cluster, false);
  assert.equal("region" in built.connections.cluster, false);
});

test("takes cluster metadata from the definition when given", () => {
  const built = suite({
    performance: { ...getWorkload, cluster: { cpuCount: 16, memory: 28000, replicas: 1, storage: "magma", instance: "c5.4xlarge" } },
  });
  assert.equal(built.connections.cluster.cpuCount, 16);
  assert.equal(built.connections.cluster.memory, 28000);
  assert.equal(built.connections.cluster.replicas, 1);
  assert.equal(built.connections.cluster.storage, "magma");
  assert.equal(built.connections.cluster.instance, "c5.4xlarge");
});

test("leaves the facts the engine measures out of the config unless the definition states them", () => {
  // The engine reads these from the cluster itself (see withMeasuredClusterFacts).
  const built = suite();
  for (const key of ["version", "nodeCount", "cpuCount", "memory"]) {
    assert.equal(key in built.connections.cluster, false, key);
  }
});

test("passes a stated cluster version/nodeCount through, for the engine to check", () => {
  const built = suite({ performance: { ...getWorkload, cluster: { version: "7.6.2-1234-enterprise", nodeCount: 1 } } });
  assert.equal(built.connections.cluster.version, "7.6.2-1234-enterprise");
  assert.equal(built.connections.cluster.nodeCount, 1);
});

test("derives both connection strings from the cluster", () => {
  const built = suite();
  assert.equal(built.connections.cluster.connection_string_driver, "couchbase://10.0.0.1");
  assert.equal(built.connections.cluster.connection_string_performer, "couchbase://10.0.0.1");
});

test("points the performer at the CNG gateway while the driver stays classic", () => {
  // The driver still needs the classic connection for its own bucket recreate.
  const built = suite({
    cluster: { ...cluster, cng: { performerConnectionString: "couchbase2://gateway:18098", tls: {} } },
  });
  assert.equal(built.connections.cluster.connection_string_driver, "couchbase://10.0.0.1");
  assert.equal(built.connections.cluster.connection_string_performer, "couchbase2://gateway:18098");
});

test("restHostname uses the TLS port for a couchbases cluster", () => {
  assert.equal(restHostname(cluster), "http://10.0.0.1:8091");
  assert.equal(restHostname({ ...cluster, scheme: "couchbases" }), "https://10.0.0.1:18091");
});

test("restHostname reduces a connection string's hosts to one management endpoint", () => {
  // The TypeScript engine drives bucket recreation and the doc-pool check through this URL, so
  // a hostname that isn't a bare host has to be handled rather than concatenated blindly.
  assert.equal(restHostname({ ...cluster, defaultHostname: "a.example.com,b.example.com" }), "http://a.example.com:8091");
  assert.equal(restHostname({ ...cluster, defaultHostname: "a.example.com:11210" }), "http://a.example.com:8091");
  assert.equal(restHostname({ ...cluster, defaultHostname: "[2001:db8::1]:11210" }), "http://[2001:db8::1]:8091");
});

test("marks an insecure-TLS cluster so the driver skips verification", () => {
  const built = suite({ cluster: { ...cluster, scheme: "couchbases", tls: { insecure: true } } });
  assert.equal(built.connections.cluster.insecure, true);
});

test("impl records the SDK's display name, which is what perf stores as the language", () => {
  assert.equal(perfImplBlock({ sdk: cpp, performerVersion: "main" }).language, "C++");
});

test("impl maps the image's OCI labels onto perf's image block", () => {
  const impl = perfImplBlock({
    sdk: java,
    performerVersion: "main",
    imageLabels: {
      "org.opencontainers.image.version": "3.7.0",
      "org.opencontainers.image.revision": "b5a960e965d7e59ebe46fab25e20099839d58c6e",
      "org.opencontainers.image.created": "2026-08-06T15:03:20.363Z",
      "org.opencontainers.image.source": "https://github.com/couchbase/couchbase-jvm-clients",
      "com.couchbase.github.actions.run": "https://github.com/couchbase/couchbase-jvm-clients/actions/runs/1",
      "org.opencontainers.image.title": "not-mapped",
    },
  });
  assert.equal(impl.version, "3.7.0");
  assert.deepEqual(impl.image, {
    revision: "b5a960e965d7e59ebe46fab25e20099839d58c6e",
    created: "2026-08-06T15:03:20.363Z",
    source: "https://github.com/couchbase/couchbase-jvm-clients",
    ciRun: "https://github.com/couchbase/couchbase-jvm-clients/actions/runs/1",
  });
});

test("impl.version falls back to the image tag when the image carries no version label", () => {
  assert.equal(perfImplBlock({ sdk: java, performerVersion: "refs-changes-18-195818-7" }).version, "refs-changes-18-195818-7");
});

test("impl omits the image block entirely when no labels could be read", () => {
  assert.equal(perfImplBlock({ sdk: java, performerVersion: "main" }).image, undefined);
});

test("countCsvDataRows ignores the header and trailing blank lines", () => {
  // A buckets.csv with only a header is the shape the driver's end-of-run flush
  // bug produced: a completed workload that recorded nothing.
  assert.equal(countCsvDataRows("timestamp,total\n"), 0);
  assert.equal(countCsvDataRows("timestamp,total\n2026-01-01T00:00:00Z,5\n"), 1);
  assert.equal(countCsvDataRows("timestamp,total\n2026-01-01T00:00:00Z,5\n2026-01-01T00:00:01Z,6\n\n"), 2);
});

test("describePerfWorkload resolves variables so the header shows real numbers", () => {
  assert.equal(describePerfWorkload(getWorkload), "get for 300s");
});

test("describePerfWorkload names a transaction by its operation count", () => {
  const workload = perfWorkloadByValue("transaction-replace-insert");
  assert.ok(workload);
  assert.equal(
    describePerfWorkload({ workload: workload.build(), variables: { forSeconds: 60, poolSize: 10 } }),
    "transaction of 2 op(s) for 60s",
  );
});

test("every catalogued workload builds at least one operation", () => {
  for (const workload of PERF_WORKLOADS) {
    assert.ok(workload.build().operations.length > 0, `${workload.value} built no operations`);
  }
});

test("catalogued workloads only claim a pool when they reference one", () => {
  for (const workload of PERF_WORKLOADS) {
    const mentionsPool = JSON.stringify(workload.build()).includes("$poolSize");
    assert.equal(workload.usesPool, mentionsPool, `${workload.value} disagrees about needing a pool`);
  }
});

test("points the performer at the box's otel collector only when there is one", () => {
  assert.equal(suite().connections.otel, undefined);
  assert.deepEqual(suite({ otelCollectorOtlpGrpc: "http://host.docker.internal:4317" }).connections.otel, {
    otlpGrpc: "http://host.docker.internal:4317",
  });
});

test("the runner is carried into the suite as given, and left out when not given", () => {
  const runner = { name: "fit-cli", commit: "0123456789abcdef0123456789abcdef01234567", dirty: true } as const;
  assert.deepEqual(suite({ runner }).runner, runner);
  assert.equal("runner" in suite(), false);
});

test("from a checkout, fitCliRunner names fit-cli and records HEAD's full commit", () => {
  // The tests run from a checkout, so this reads this repo's real HEAD and status.
  const runner = fitCliRunner();
  assert.equal(runner.name, "fit-cli");
  assert.match(runner.commit ?? "", /^[0-9a-f]{40}$/);
  assert.ok(runner.dirty === undefined || runner.dirty === true);
});

test("assessPerfBundles: a skipped run is ok, uploads nothing, and says why", () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "fit-perf-assess-"));
  mkdirSync(join(resultsDir, "aaaaaaaa"));
  writePerfSkipMarker(join(resultsDir, "aaaaaaaa"), "no cap");
  const assessment = assessPerfBundles(resultsDir, "aaaaaaaa-0000-4000-8000-000000000001");
  assert.deepEqual(assessment, { ok: true, reasons: [], bundles: [], bucketRows: 0, skipped: [{ bundle: "aaaaaaaa", reason: "no cap" }] });
});

test("assessPerfBundles: a skipped sibling doesn't change how a measured run is judged", () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "fit-perf-assess-"));
  mkdirSync(join(resultsDir, "aaaaaaaa"));
  writePerfSkipMarker(join(resultsDir, "aaaaaaaa"), "no cap");
  mkdirSync(join(resultsDir, "bbbbbbbb"));
  writeFileSync(join(resultsDir, "bbbbbbbb", "buckets.csv"), "header\n");
  const assessment = assessPerfBundles(resultsDir);
  assert.equal(assessment.ok, false);
  assert.deepEqual(assessment.bundles, [join(resultsDir, "bbbbbbbb")]);
  assert.deepEqual(assessment.skipped, [{ bundle: "aaaaaaaa", reason: "no cap" }]);
});
