import assert from "node:assert/strict";
import { test } from "node:test";
import { functionalInstanceConnectivity } from "../create-definition.js";
import { definitionRunGuidance } from "../../definition/run-guidance.js";
import type { InstanceLifetime } from "../../definition/types.js";

test("definitionRunGuidance names the sandbox env vars only when the definition targets a sandbox", () => {
  const plain = definitionRunGuidance("fit.json5");
  assert.ok(!plain.includes("CAPELLA_API_SECRET"), "non-sandbox guidance should not mention sandbox creds");
  const sandbox = definitionRunGuidance("fit.json5", true);
  assert.match(sandbox, /Capella sandbox/);
  assert.match(sandbox, /CAPELLA_USER.*CAPELLA_API_SECRET/s);
});

const NODES = [{ count: 1, version: "8.1.0-2188", services: ["kv"] }];

test("a cbdinocluster instance with a cao block is CNG", () => {
  const instance: InstanceLifetime = {
    localhost: {},
    clusters: [
      {
        cbdinocluster: {
          config: { nodes: NODES, cao: { "operator-version": "2.8.0", "gateway-version": "1.1.0-135" } },
        },
        sessions: [],
      },
    ],
  };
  assert.equal(functionalInstanceConnectivity(instance), "cng");
});

test("a cbdinocluster instance without a cao block is operational", () => {
  const instance: InstanceLifetime = {
    localhost: {},
    clusters: [{ cbdinocluster: { config: { nodes: NODES } }, sessions: [] }],
  };
  assert.equal(functionalInstanceConnectivity(instance), "operational");
});

test("a cbdinocluster instance with columnar:true is Enterprise Analytics", () => {
  const instance: InstanceLifetime = {
    localhost: {},
    clusters: [{ cbdinocluster: { config: { nodes: NODES, columnar: true } }, sessions: [] }],
  };
  assert.equal(functionalInstanceConnectivity(instance), "enterprise-analytics");
});

test("connectivity is resolved through a clusterConfig reference", () => {
  const instance: InstanceLifetime = {
    localhost: {},
    clusters: [{ clusterConfig: "cluster-0", sessions: [] }],
  };
  assert.equal(
    functionalInstanceConnectivity(instance, [
      { id: "cluster-0", cbdinocluster: { config: { nodes: NODES, columnar: true } } },
    ]),
    "enterprise-analytics",
  );
});

test("a connection instance is operational", () => {
  const instance: InstanceLifetime = {
    localhost: {},
    clusters: [
      {
        connection: {
          connectionString: "couchbase://localhost",
          username: "Administrator",
          password: "password",
        },
        sessions: [],
      },
    ],
  };
  assert.equal(functionalInstanceConnectivity(instance), "operational");
});
