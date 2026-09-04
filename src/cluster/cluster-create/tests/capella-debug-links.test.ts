import assert from "node:assert/strict";
import { test } from "node:test";
import { capellaDebugLinks, printCapellaPreflightInfo } from "../capella-debug-links.js";
import type { EnvironmentsFile } from "../../../fit/util/environments.js";

const environments: EnvironmentsFile = {
  defaults: {
    clusterVersion: "8.0-stable",
    previousClusterVersion: "7.6-stable",
    nextClusterVersion: "8.5-stable",
    cngClusterVersion: "8.0.2-5503",
    enterpriseAnalyticsVersion: "2.2.0-1166",
    caoOperatorVersion: "2.9.2",
    cngVersion: "1.2.1-123",
    capellaClusterVersion: "8.0",
    capellaPreviousClusterVersion: "7.6",
    defaultCapellaEnvironment: "prod",
    defaultResultsEnvironment: "prod",
    cbdinoclusterVersion: "v0.0.120",
    capellaKeyPool: { enabled: true, size: 10, expiryDays: 1 },
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
    prod: { endpoint: "https://api.cloud.couchbase.com", v4Endpoint: "https://cloudapi.cloud.couchbase.com", oid: "62488bdd-d416-467e-84f7-fc7c1583a083" },
    dev: { endpoint: "https://api.dev.nonprod-project-avengers.com", oid: "6af08c0a-8cab-4c1c-b257-b521575c16d0" },
    noOid: { endpoint: "https://api.no-oid.example.com" },
    sandbox: {
      sandbox: true,
      endpoint: "https://api.sbx-25.sandbox.nonprod-project-avengers.com",
      oid: "4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01",
    },
  },
  results: {},
  awsTenants: {},
  fitCliRole: { accountId: "958525475024", roleName: "fit-cli-role" },
};

const uuid = "b0652a58-45d4-4cf7-afff-343ca735c6c6";

test("capellaDebugLinks derives the dev UI, Fleet Manager and DataDog hosts from the endpoint", () => {
  const links = capellaDebugLinks("dev", uuid, environments);
  assert.deepEqual(links, {
    capellaUiUrl: "https://dev.nonprod-project-avengers.com/databases?oid=6af08c0a-8cab-4c1c-b257-b521575c16d0",
    fleetManagerUrl: `https://fm.dev.nonprod-project-avengers.com/clusters/${uuid}`,
    datadogLogsUrl: `https://app.datadoghq.com/logs?query=env%3Adev%20%40clusterId%3A${uuid}`,
  });
});

test("capellaDebugLinks derives the prod UI, Fleet Manager and DataDog hosts from the endpoint", () => {
  const links = capellaDebugLinks("prod", uuid, environments);
  assert.deepEqual(links, {
    capellaUiUrl: "https://cloud.couchbase.com/databases?oid=62488bdd-d416-467e-84f7-fc7c1583a083",
    fleetManagerUrl: `https://fm.cloud.couchbase.com/clusters/${uuid}`,
    datadogLogsUrl: `https://app.datadoghq.com/logs?query=env%3Aprod%20%40clusterId%3A${uuid}`,
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

test("printCapellaPreflightInfo logs environment, org id, both endpoints and the org UI link", () => {
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
    "  Capella v4 endpoint: https://cloudapi.cloud.couchbase.com",
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

test("capellaDebugLinks points a sandbox at its ui. host rather than the bare domain", () => {
  const links = capellaDebugLinks("sandbox", uuid, environments);
  assert.equal(
    links?.capellaUiUrl,
    "https://ui.sbx-25.sandbox.nonprod-project-avengers.com/databases?oid=4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01",
  );
});

test("capellaUiUrl gives no sandbox link when the endpoint has no ui./api./cloudapi. label to swap", () => {
  const noLabel: EnvironmentsFile = {
    ...environments,
    capella: { ...environments.capella, sandbox: { sandbox: true, endpoint: "https://sbx-25.example.com", oid: "4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01" } },
  };
  // Better no link than one pointing at the control-plane API host.
  assert.equal(capellaDebugLinks("sandbox", uuid, noLabel)?.capellaUiUrl, undefined);
});

test("capellaUiUrl matches the sandbox label case-insensitively, canonicalising to lower case", () => {
  const upper: EnvironmentsFile = {
    ...environments,
    capella: { ...environments.capella, sandbox: { sandbox: true, endpoint: "HTTPS://API.sbx-25.example.com", oid: "abc" } },
  };
  assert.equal(capellaDebugLinks("sandbox", uuid, upper)?.capellaUiUrl, "https://ui.sbx-25.example.com/databases?oid=abc");
});
