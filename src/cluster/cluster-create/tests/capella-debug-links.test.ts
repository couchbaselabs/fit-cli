import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDebugLinks, capellaDebugLinks } from "../capella-debug-links.js";
import type { EnvironmentsFile } from "../../../fit/util/environments.js";

const environments: EnvironmentsFile = {
  defaults: {
    clusterVersion: "8.0-stable",
    previousClusterVersion: "7.6-stable",
    cngClusterVersion: "8.0.2-5503",
    enterpriseAnalyticsVersion: "2.2.0-1166",
    caoOperatorVersion: "2.9.2",
    cngVersion: "1.2.1-123",
    capellaClusterVersion: "8.0",
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
    prod: { endpoint: "https://api.cloud.couchbase.com", oid: "62488bdd-d416-467e-84f7-fc7c1583a083" },
    dev: { endpoint: "https://api.dev.nonprod-project-avengers.com", oid: "6af08c0a-8cab-4c1c-b257-b521575c16d0" },
    noOid: { endpoint: "https://api.no-oid.example.com" },
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

test("buildDebugLinks builds the debug.items[] shape for a configured environment", () => {
  const links = buildDebugLinks("dev", uuid, undefined, environments);
  assert.deepEqual(
    links.map((l) => l.label),
    ["Capella UI", "Fleet Manager", "DataDog logs"],
  );
  assert.equal(links[0]?.url, "https://dev.nonprod-project-avengers.com/databases?oid=6af08c0a-8cab-4c1c-b257-b521575c16d0");
  assert.equal(links[1]?.description, "Needs VPN access.");
});

test("buildDebugLinks returns an empty array for an unconfigured environment", () => {
  assert.deepEqual(buildDebugLinks("staging", uuid, undefined, environments), []);
});

test("buildDebugLinks appends a run-archive link when archiveZipKey is given", () => {
  const links = buildDebugLinks("dev", uuid, "s3://fit-cli/runs/20260713-120000-ab12.zip", environments);
  const archiveLink = links.find((l) => l.label === "Run archive");
  assert.ok(archiveLink);
  assert.equal(archiveLink.command, "fit archive fetch s3://fit-cli/runs/20260713-120000-ab12.zip");
});
