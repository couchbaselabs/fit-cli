import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCapellaDebugItems, capellaDebugLinks, defaultDatadogWindow, printCapellaPreflightInfo } from "../capella-debug-links.js";
import type { EnvironmentsFile } from "../../../fit/util/environments.js";

const environments: EnvironmentsFile = {
  defaults: {
    clusterVersion: "8.0-stable",
    previousClusterVersion: "7.6-stable",
    nextClusterVersion: "8.5-stable",
    cngClusterVersion: "8.5.0-1060",
    cngPreviousClusterVersion: "8.0.2-5503",
    enterpriseAnalyticsVersion: "2.2.0-1166",
    operationalInsightsVersion: "3.0.0-1084",
    caoOperatorVersion: "2.9.2",
    cngVersion: "1.2.1-123",
    capellaClusterVersion: "8.0",
    capellaPreviousClusterVersion: "7.6",
    defaultCapellaEnvironment: "prod",
    defaultResultsEnvironment: "prod",
    cbdinoclusterVersion: "v0.0.120",
    capellaKeyPool: { enabled: true, size: 10, expiryDays: 1 },
    aws: { region: "us-west-2", vpcId: "vpc-x", subnetId: "subnet-x" },
    perfClusterVersion: "8.0.0",
  },
  externalServices: {
    otel: { collectorVersion: "0.135.0", jaegerVersion: "1.62.0", prometheusVersion: "v2.55.0" },
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
  perf: {
    driverVer: 6,
    performerVer: 1,
    aws: { instanceType: "c5.4xlarge" },
    docker: { "kv-memory": 28000 },
    pooledVariables: { forSeconds: 300, horizontalScaling: 20, poolSize: 10000 },
    insertVariables: { forSeconds: 300, horizontalScaling: 20, docNum: 10000000 },
    workloads: { kvGet: { operations: [] }, kvReplace: { operations: [] }, kvInsert: { operations: [] }, txnWrite: { operations: [] } },
  },
  capella: {
    prod: { endpoint: "https://api.cloud.couchbase.com", oid: "62488bdd-d416-467e-84f7-fc7c1583a083" },
    dev: { endpoint: "https://api.dev.nonprod-project-avengers.com", oid: "6af08c0a-8cab-4c1c-b257-b521575c16d0" },
    noOid: { endpoint: "https://api.no-oid.example.com" },
  },
  results: {},
  awsTenants: {},
  fitCliRole: { accountId: "958525475024", roleName: "fit-cli-role" },
};

const uuid = "b0652a58-45d4-4cf7-afff-343ca735c6c6";
const window = { from: new Date("2026-11-04T10:10:00Z"), to: new Date("2026-11-04T10:40:00Z") };
const datadogUrl =
  `https://app.datadoghq.com/logs?query=%40clusterId%3A${uuid}&from_ts=1793787000000&to_ts=1793788800000&live=false`;

test("capellaDebugLinks derives the dev UI, Fleet Manager and DataDog hosts from the endpoint", () => {
  const links = capellaDebugLinks("dev", uuid, environments, window);
  assert.deepEqual(links, {
    capellaUiUrl: "https://dev.nonprod-project-avengers.com/databases?oid=6af08c0a-8cab-4c1c-b257-b521575c16d0",
    fleetManagerUrl: `https://fm.dev.nonprod-project-avengers.com/clusters/${uuid}`,
    datadogLogsUrl: datadogUrl,
  });
});

test("capellaDebugLinks derives the prod UI, Fleet Manager and DataDog hosts from the endpoint", () => {
  const links = capellaDebugLinks("prod", uuid, environments, window);
  assert.deepEqual(links, {
    capellaUiUrl: "https://cloud.couchbase.com/databases?oid=62488bdd-d416-467e-84f7-fc7c1583a083",
    fleetManagerUrl: `https://fm.cloud.couchbase.com/clusters/${uuid}`,
    datadogLogsUrl: datadogUrl,
  });
});

test("defaultDatadogWindow spans from just before now to past the longest cluster expiry", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  assert.deepEqual(defaultDatadogWindow(now), {
    from: new Date("2026-11-04T09:30:00Z"),
    to: new Date("2026-11-05T18:00:00Z"),
  });
});

test("capellaDebugLinks omits capellaUiUrl when the environment has no oid", () => {
  const links = capellaDebugLinks("noOid", uuid, environments);
  assert.equal(links?.capellaUiUrl, undefined);
  assert.ok(links?.fleetManagerUrl);
});

test("capellaDebugLinks returns undefined for an unconfigured environment", () => {
  assert.equal(capellaDebugLinks("staging", uuid, environments), undefined);
});

test("printCapellaPreflightInfo logs environment, org id, endpoint and the org UI link", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    printCapellaPreflightInfo("prod", environments);
  } finally {
    console.log = original;
  }
  assert.deepEqual(lines, [
    "  Capella environment: prod",
    "  Capella org id: 62488bdd-d416-467e-84f7-fc7c1583a083",
    "  Capella endpoint: https://api.cloud.couchbase.com",
    "  Capella UI (prod): https://cloud.couchbase.com/databases?oid=62488bdd-d416-467e-84f7-fc7c1583a083",
  ]);
});

test("printCapellaPreflightInfo is a no-op for an unconfigured environment", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    printCapellaPreflightInfo("staging", environments);
  } finally {
    console.log = original;
  }
  assert.deepEqual(lines, []);
});

test("buildCapellaDebugItems builds the debug.items[] links for a configured environment", () => {
  const items = buildCapellaDebugItems("dev", uuid, environments);
  assert.deepEqual(
    items.map((i) => i.label),
    ["Capella UI", "Fleet Manager", "DataDog logs"],
  );
  assert.equal(items[0]?.url, "https://dev.nonprod-project-avengers.com/databases?oid=6af08c0a-8cab-4c1c-b257-b521575c16d0");
  assert.equal(items[1]?.description, "Needs VPN access.");
});

test("buildCapellaDebugItems returns nothing for an unconfigured environment", () => {
  assert.deepEqual(buildCapellaDebugItems("staging", uuid, environments), []);
});
