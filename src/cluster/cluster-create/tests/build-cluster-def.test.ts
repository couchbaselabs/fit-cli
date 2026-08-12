/**
 * Unit tests for buildClusterDef.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/workflows/cluster/cluster-create/tests/build-cluster-def.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEnvironments } from "../../../fit/util/environments.js";
import {
  DOCKER_SERVICE_MEMORY_MB,
  buildClusterDef,
  buildClusterDefObject,
  cbdinoAnalyticsClusterProduct,
} from "../build-cluster-def.js";

const { caoOperatorVersion: CAO_OPERATOR_VERSION, cngVersion: CNG_VERSION } = loadEnvironments().defaults;

test("a basic single-node def renders the nodes block", () => {
  const def = buildClusterDef({
    nodeCount: 1,
    version: "8.1.0",
    services: ["kv", "n1ql", "index", "fts"],
    cng: false,
  });
  assert.equal(
    def,
    "nodes:\n  - count: 1\n    version: '8.1.0'\n    services: [kv, n1ql, index, fts]\n",
  );
});

test("the node count and version are passed through", () => {
  const def = buildClusterDef({
    nodeCount: 3,
    version: "7.6.2-3505",
    services: ["kv"],
    cng: false,
  });
  assert.match(def, /- count: 3/);
  assert.match(def, /version: '7.6.2-3505'/);
});

test("CNG support adds the cao block with the operator and gateway versions", () => {
  const def = buildClusterDef({
    nodeCount: 1,
    version: "8.1.0",
    services: ["kv"],
    cng: true,
  });
  assert.match(def, /cao:/);
  assert.match(def, new RegExp(`operator-version: "${CAO_OPERATOR_VERSION}"`));
  assert.match(def, new RegExp(`gateway-version: "${CNG_VERSION}"`));
});

test("without CNG there is no cao block", () => {
  const def = buildClusterDef({
    nodeCount: 1,
    version: "8.1.0",
    services: ["kv"],
    cng: false,
  });
  assert.doesNotMatch(def, /cao:/);
});

test("the def always ends with a trailing newline", () => {
  const def = buildClusterDef({ nodeCount: 1, version: "8.1.0", services: ["kv"], cng: false });
  assert.ok(def.endsWith("\n"));
});

test("buildClusterDefObject auto-emits docker RAM quotas for kv and fts", () => {
  const def = buildClusterDefObject({
    nodeCount: 3,
    version: "8.1.0",
    services: ["kv", "n1ql", "index", "fts"],
    cng: false,
  });
  assert.deepEqual(def.docker, {
    "kv-memory": DOCKER_SERVICE_MEMORY_MB,
    "fts-memory": DOCKER_SERVICE_MEMORY_MB,
  });
});

test("buildClusterDefObject omits docker when neither kv nor fts is present", () => {
  const def = buildClusterDefObject({
    nodeCount: 1,
    version: "8.1.0",
    services: ["n1ql", "index"],
    cng: false,
  });
  assert.equal(def.docker, undefined);
});

test("buildClusterDefObject uses cao (not docker) for CNG clusters", () => {
  const def = buildClusterDefObject({
    nodeCount: 3,
    version: "8.1.0",
    services: ["kv", "fts"],
    cng: true,
  });
  assert.equal(def.docker, undefined);
  assert.equal(def.cao?.["operator-version"], CAO_OPERATOR_VERSION);
});

test("buildClusterDefObject emits data-api in the cloud section when capellaDataApi is set", () => {
  const def = buildClusterDefObject({
    nodeCount: 3,
    version: "7.6",
    services: [],
    cng: false,
    capellaCloudProvider: "aws",
    capellaDataApi: true,
  });
  assert.deepEqual(def.cloud, { "cloud-provider": "aws", "data-api": true });
});

test("buildClusterDefObject omits data-api by default for Capella clusters", () => {
  const def = buildClusterDefObject({
    nodeCount: 3,
    version: "7.6",
    services: [],
    cng: false,
    capellaCloudProvider: "aws",
  });
  assert.deepEqual(def.cloud, { "cloud-provider": "aws" });
});

test("buildClusterDefObject never emits data-api for Capella Analytics clusters", () => {
  // Capella Analytics rejects the data-api field, so it must not appear on that path.
  const def = buildClusterDefObject({
    nodeCount: 2,
    version: "",
    services: [],
    cng: false,
    capellaAnalytics: true,
    cloudProvider: "aws",
    capellaDataApi: true,
  });
  assert.deepEqual(def.cloud, { "cloud-provider": "aws" });
});

test("buildClusterDefObject emits cbdino columnar:true + an nginx load balancer for a self-managed Enterprise Analytics cluster", () => {
  const def = buildClusterDefObject({
    nodeCount: 2,
    version: "2.2.0-1166",
    services: [],
    cng: false,
    enterpriseAnalytics: true,
  });
  // On the cbdino wire this is `columnar: true`.
  assert.equal(def.columnar, true);
  assert.equal(cbdinoAnalyticsClusterProduct(def), "enterprise-analytics");
  // No per-node service list and no cao block.
  assert.deepEqual(def.nodes, [{ count: 2, version: "2.2.0-1166" }]);
  assert.equal(def.cao, undefined);
  assert.equal(def.docker?.["passive-load-balancer"], true);
  assert.equal(def.docker?.["use-dino-certs"], true);
});
