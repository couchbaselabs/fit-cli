import assert from "node:assert/strict";
import { test } from "node:test";
import { clusterFactsFrom, withMeasuredClusterFacts } from "../perf-cluster-rest.js";

// Trimmed from a real cbdinocluster `version: 8.0.0` cluster's /pools and /pools/default.
const POOLS = JSON.stringify({ isAdminCreds: true, isEnterprise: true, implementationVersion: "8.0.0-3777-enterprise", pools: [] });
const POOLS_DEFAULT = JSON.stringify({
  name: "default",
  memoryQuota: 28000,
  indexMemoryQuota: 512,
  nodes: [{ hostname: "172.18.0.2:8091", status: "healthy", cpuCount: 16, version: "8.0.0-3777-enterprise" }],
});

test("clusterFactsFrom reads what jenkins-sdk's modifyConfigClusters recorded", () => {
  assert.deepEqual(clusterFactsFrom(POOLS, POOLS_DEFAULT), {
    version: "8.0.0-3777-enterprise",
    memory: 28000,
    cpuCount: 16,
    nodeCount: 1,
  });
});

test("clusterFactsFrom counts every node, and takes cpuCount from the first", () => {
  const body = JSON.stringify({ memoryQuota: 1024, nodes: [{ cpuCount: 8 }, { cpuCount: 4 }, { cpuCount: 4 }] });
  assert.deepEqual(clusterFactsFrom(POOLS, body), { version: "8.0.0-3777-enterprise", memory: 1024, cpuCount: 8, nodeCount: 3 });
});

test("clusterFactsFrom leaves out what the bodies don't carry", () => {
  assert.deepEqual(clusterFactsFrom("{}", "{}"), {});
});

const MEASURED = { version: "8.0.0-3777-enterprise", memory: 28000, cpuCount: 16, nodeCount: 1 };

test("withMeasuredClusterFacts fills in the measured facts", () => {
  const out = withMeasuredClusterFacts({ type: "unmanaged", replicas: 0 }, MEASURED);
  assert.deepEqual(out, { type: "unmanaged", replicas: 0, ...MEASURED });
});

test("withMeasuredClusterFacts accepts stated facts that agree with the cluster", () => {
  const out = withMeasuredClusterFacts({ version: "8.0.0-3777-enterprise", cpuCount: 16, nodeCount: 1 }, MEASURED);
  assert.deepEqual(out, MEASURED);
});

test("withMeasuredClusterFacts rejects a stated fact the cluster contradicts, rather than recording it", () => {
  // e.g. a preset that says 16 CPUs run on a smaller instance: recording 16 would file the
  // run under history it doesn't belong to.
  assert.throws(
    () => withMeasuredClusterFacts({ cpuCount: 16, version: "8.0.0" }, { ...MEASURED, cpuCount: 8 }),
    (err: Error) => /cpuCount/.test(err.message) && /version/.test(err.message),
  );
});

test("withMeasuredClusterFacts keeps a stated memory, which is the bucket quota the run chose", () => {
  assert.equal(withMeasuredClusterFacts({ memory: 1024 }, MEASURED).memory, 1024);
});

test("withMeasuredClusterFacts fails when a recorded fact can't be determined", () => {
  assert.throws(() => withMeasuredClusterFacts({}, { version: "8.0.0-3777-enterprise", memory: 28000, nodeCount: 1 }), /cpuCount/);
});
