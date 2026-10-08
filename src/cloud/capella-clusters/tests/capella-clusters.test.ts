/**
 * Unit tests for the pure parsing/targeting helpers behind the capella-clusters
 * command. Nothing here runs cbdinocluster.
 *
 * Run on their own:
 *   node --import tsx --test src/cloud/capella-clusters/tests/capella-clusters.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedCapellaConfig } from "../../../fit/util/config.js";
import {
  CLEANUP_TIMEOUT,
  capellaInitEnv,
  cleanupArgs,
  destroyFailedAnnotation,
  destroyFailedClusters,
  expiredClusters,
  formatClustersTable,
  parseCloudClusters,
  type CbdinoclusterListItem,
} from "../capella-clusters.js";

const NOW = Date.parse("2026-06-15T12:00:00Z");
const PAST = "2026-06-15T10:00:00Z";
const FUTURE = "2026-06-15T14:00:00Z";
const OURS = "fitcli-20260615-090000-ab12-someone";

function cluster(overrides: Partial<CbdinoclusterListItem> & { id: string }): CbdinoclusterListItem {
  return { type: "server", state: "healthy", deployer: "cloud", ...overrides };
}

/** A `cbdinocluster ps --json` payload with one Capella cluster and one docker cluster. */
const PS_JSON = JSON.stringify([
  {
    id: "aaaaaaaa1111222233334444",
    type: "server",
    state: "healthy",
    purpose: OURS,
    expiry: PAST,
    deployer: "cloud",
    cloud_project_id: "12c12145-b634-4409-9748-a34df7f9210d",
    nodes: [],
  },
  { id: "bbbbbbbb1111222233334444", type: "server", state: "ready", deployer: "docker", nodes: [] },
]);

test("parseCloudClusters keeps only the cloud deployer's clusters", () => {
  const clusters = parseCloudClusters(PS_JSON);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].id, "aaaaaaaa1111222233334444");
  assert.equal(clusters[0].purpose, OURS);
});

test("parseCloudClusters handles the empty cases cbdinocluster prints", () => {
  assert.deepEqual(parseCloudClusters("null"), []);
  assert.deepEqual(parseCloudClusters("[]"), []);
  assert.deepEqual(parseCloudClusters("  \n"), []);
});

test("expiredClusters selects only clusters whose expiry has passed", () => {
  const clusters = [cluster({ id: "past", expiry: PAST }), cluster({ id: "future", expiry: FUTURE })];
  assert.deepEqual(
    expiredClusters(clusters, NOW).map((c) => c.id),
    ["past"],
  );
});

test("expiredClusters treats a missing or unparseable expiry as live", () => {
  const clusters = [cluster({ id: "none" }), cluster({ id: "junk", expiry: "not-a-date" })];
  assert.deepEqual(expiredClusters(clusters, NOW), []);
});

test("destroyFailedClusters picks only the clusters Capella failed to destroy", () => {
  const clusters = [
    cluster({ id: "stuck", purpose: OURS, expiry: PAST, state: "destroyFailed" }),
    cluster({ id: "stuck-theirs", expiry: FUTURE, state: "destroyFailed" }),
    cluster({ id: "expired", purpose: OURS, expiry: PAST }),
    cluster({ id: "corrupted", expiry: PAST, state: "corrupted" }),
  ];
  assert.deepEqual(
    destroyFailedClusters(clusters).map((c) => c.id),
    ["stuck", "stuck-theirs"],
  );
});

test("destroyFailedAnnotation names the cluster, its purpose and the environment", () => {
  const line = destroyFailedAnnotation(cluster({ id: "stuck", purpose: OURS, state: "destroyFailed" }), "prod");
  assert.equal(line, `::warning title=Capella destroyFailed needs a human::stuck purpose ${OURS} in prod organization`);
});

test("destroyFailedAnnotation reports a missing purpose as none", () => {
  const line = destroyFailedAnnotation(cluster({ id: "stuck", state: "destroyFailed" }), "dev");
  assert.equal(line, "::warning title=Capella destroyFailed needs a human::stuck purpose none in dev organization");
});

test("cleanupArgs bounds a real cleanup by the timeout", () => {
  assert.deepEqual(cleanupArgs(false), ["cleanup", "cloud", "--timeout", CLEANUP_TIMEOUT]);
  assert.equal(CLEANUP_TIMEOUT, "90m");
});

test("cleanupArgs asks cbdinocluster for a dry run with no timeout", () => {
  assert.deepEqual(cleanupArgs(true), ["cleanup", "cloud", "--dry-run"]);
});

test("formatClustersTable shows the purpose and marks the expired clusters", () => {
  const table = formatClustersTable(parseCloudClusters(PS_JSON), NOW);
  const [header, , row] = table.split("\n");
  assert.match(header, /ID\s+\| TYPE\s+\| STATE\s+\| PURPOSE\s+\| EXPIRY \(UTC\)\s+\| EXPIRED/);
  assert.match(row, /aaaaaaaa1111222233334444/);
  assert.match(row, new RegExp(OURS));
  assert.match(row, /2026-06-15 10:00:00/);
  assert.match(row, /EXPIRED\s*$/);
});

test("formatClustersTable shows a cluster with no purpose and no expiry as neither", () => {
  const row = formatClustersTable([cluster({ id: "bare" })], NOW).split("\n")[2];
  assert.match(row, /bare\s+\| server\s+\| healthy\s+\| \(none\)\s+\| none\s+\| -/);
});

const CAPELLA: ResolvedCapellaConfig = {
  username: "sdk_qe@couchbase.com",
  endpoint: "https://api.dev.example",
  v4Endpoint: "https://cloudapi.dev.example",
  organizationId: "oid-dev",
  password: "pw",
  apiKey: "key",
  apiSecret: "secret",
};

test("capellaInitEnv forwards CAPELLA_PROJECT_ID when the project id is set", () => {
  const env = capellaInitEnv({ ...CAPELLA, projectId: "pid-dev" });
  assert.equal(env.CAPELLA_PROJECT_ID, "pid-dev");
  assert.equal(env.CAPELLA_OID, "oid-dev");
});

test("capellaInitEnv clears CAPELLA_PROJECT_ID when the project id is unset", () => {
  assert.equal(capellaInitEnv(CAPELLA).CAPELLA_PROJECT_ID, "");
});
