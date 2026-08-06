import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergeDebugItemsIntoRunParams, writeDebugLinksFromBundles, writeRunParams } from "../update-run-debug-links.js";
import { readSituationalRunBundle } from "../../../shared/run-test-driver/situational-results.js";
import type { SituationalRunBundle } from "../../../shared/run-test-driver/situational-results.js";
import type { EnvironmentsFile } from "../../../util/environments.js";

const environments: EnvironmentsFile = {
  defaults: {
    clusterVersion: "8.0-stable",
    previousClusterVersion: "7.6-stable",
    cngClusterVersion: "8.0.2-5503",
    enterpriseAnalyticsVersion: "2.2.0-1166",
    caoOperatorVersion: "2.9.2",
    cngVersion: "1.2.1-123",
    capellaClusterVersion: "7.6",
    capellaPreviousClusterVersion: "7.6",
    defaultCapellaEnvironment: "prod",
    defaultResultsEnvironment: "prod",
    aws: { region: "us-west-2", vpcId: "vpc-x", subnetId: "subnet-x" },
  },
  testSets: {
    SITUATIONAL_SET_SANITY: "com.couchbase.situational.tests.SanityTest",
    SITUATIONAL_CNG_SET_SANITY: "com.couchbase.situational.tests.CngTest#rebalance3To4NodesDuringMixedKv",
    SITUATIONAL_SET_LITE: "standard-qe",
    SITUATIONAL_SET_RELEASE: "standard-qe",
    FUNCTIONAL_SET_SANITY: "com.couchbase.client.kv.SanityTest",
    FUNCTIONAL_SET_LITE: "all",
    FUNCTIONAL_SET_RELEASE: "all",
  },
  capella: {
    prod: { endpoint: "https://api.cloud.couchbase.com", oid: "org-1" },
  },
  results: {
    dev: { host: "faas.couchbase.com" },
    prod: { host: "performance-sdk.couchbase.com" },
  },
  awsTenants: {},
  fitCliRole: { accountId: "958525475024", roleName: "fit-cli-role" },
};

/**
 * Write a minimal run.json5 into `dir` — with `facts` as `{label, description}` items under
 * `forDatabase.debug.items`, matching how the test-driver actually writes the cluster
 * tracking id, Capella cluster id, and Capella environment — and read it back as a
 * {@link SituationalRunBundle}.
 */
function bundleWithRunJson5(dir: string, facts: { capellaCloudClusterId?: string; capellaEnvironment?: string }): SituationalRunBundle {
  const labels: Record<string, string> = { capellaCloudClusterId: "Capella cluster id", capellaEnvironment: "Capella environment" };
  const items = Object.entries(facts)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, description]) => ({ label: labels[key] ?? key, description }));
  writeFileSync(join(dir, "run.json5"), JSON.stringify({ forDatabase: { runUuid: "run-1", debug: { items } } }));
  return readSituationalRunBundle("run-1", dir);
}

test("mergeDebugItemsIntoRunParams sets forDatabase.debug.items, keeping other debug/forDatabase fields", () => {
  const merged = mergeDebugItemsIntoRunParams(
    { forDatabase: { runUuid: "run-1", debug: { capellaEnvironment: "prod" } } },
    [{ label: "Capella UI", url: "https://cloud.couchbase.com/databases" }],
  );
  assert.deepEqual(merged, {
    forDatabase: {
      runUuid: "run-1",
      debug: {
        capellaEnvironment: "prod",
        items: [{ label: "Capella UI", url: "https://cloud.couchbase.com/databases" }],
      },
    },
  });
});

test("mergeDebugItemsIntoRunParams tolerates a missing forDatabase/debug block", () => {
  const merged = mergeDebugItemsIntoRunParams({}, [{ label: "Capella UI", url: "https://x" }]);
  assert.deepEqual(merged, { forDatabase: { debug: { items: [{ label: "Capella UI", url: "https://x" }] } } });
});

test("mergeDebugItemsIntoRunParams appends to items the test-driver already wrote, rather than replacing them", () => {
  const merged = mergeDebugItemsIntoRunParams(
    { forDatabase: { runUuid: "run-1", debug: { items: [{ label: "CI URL", url: "https://ci.example.com/1" }] } } },
    [{ label: "Capella UI", url: "https://cloud.couchbase.com/databases" }],
  );
  assert.deepEqual(merged, {
    forDatabase: {
      runUuid: "run-1",
      debug: {
        items: [
          { label: "CI URL", url: "https://ci.example.com/1" },
          { label: "Capella UI", url: "https://cloud.couchbase.com/databases" },
        ],
      },
    },
  });
});

test("writeRunParams overwrites run.json5", () => {
  const dir = mkdtempSync(join(tmpdir(), "debug-links-"));
  try {
    writeRunParams(dir, { runUuid: "run-1" });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "run.json5"), "utf8")), { runUuid: "run-1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDebugLinksFromBundles merges forDatabase.debug.items into run.json5 for a bundle with a Capella cloud cluster id", () => {
  const dir = mkdtempSync(join(tmpdir(), "debug-links-"));
  try {
    const bundle = bundleWithRunJson5(dir, {
      capellaCloudClusterId: "b0652a58-45d4-4cf7-afff-343ca735c6c6",
      capellaEnvironment: "prod",
    });
    writeDebugLinksFromBundles([bundle], undefined, environments);
    const runParams = JSON.parse(readFileSync(join(dir, "run.json5"), "utf8")) as {
      forDatabase: { debug: { items: { label: string; description?: string }[] } };
    };
    const items = runParams.forDatabase.debug.items;
    assert.ok(items.length > 2);
    // The test-driver's own fact items survive the merge.
    assert.ok(items.some((i) => i.label === "Capella environment" && i.description === "prod"));
    // fit-cli's resolved links were appended.
    assert.ok(items.some((i) => i.label === "Capella UI"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDebugLinksFromBundles leaves run.json5 untouched for a bundle with no Capella cloud cluster id", () => {
  const dir = mkdtempSync(join(tmpdir(), "debug-links-"));
  try {
    const bundle = bundleWithRunJson5(dir, { capellaEnvironment: "prod" });
    const before = readFileSync(join(dir, "run.json5"), "utf8");
    writeDebugLinksFromBundles([bundle], undefined, environments);
    assert.equal(readFileSync(join(dir, "run.json5"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
