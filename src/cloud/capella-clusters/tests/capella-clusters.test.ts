/**
 * Unit tests for the pure parsing/targeting helpers behind the capella-clusters
 * command. Nothing here runs cbdinocluster.
 *
 * Run on their own:
 *   node --import tsx --test src/cloud/capella-clusters/tests/capella-clusters.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expiredClusters,
  formatClustersTable,
  parseCloudClusters,
  planSweep,
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

test("planSweep removes only fit-cli's own expired clusters", () => {
  const clusters = [
    cluster({ id: "ours-expired", purpose: OURS, expiry: PAST }),
    cluster({ id: "ours-live", purpose: OURS, expiry: FUTURE }),
    cluster({ id: "theirs-expired", purpose: "tf_acc_test_project_common", expiry: PAST }),
    cluster({ id: "unlabelled-expired", expiry: PAST }),
  ];
  const plan = planSweep(clusters, { now: NOW });
  assert.deepEqual(
    plan.remove.map((c) => c.id),
    ["ours-expired"],
  );
  // Everything left alone is accounted for, so a quiet run can't hide a decision.
  assert.deepEqual(
    plan.skipped.flatMap(({ clusters: group }) => group.map((c) => c.id)).sort(),
    ["theirs-expired", "unlabelled-expired", "ours-live"].sort(),
  );
});

test("planSweep leaves a cluster Capella failed to destroy for a human", () => {
  const clusters = [cluster({ id: "stuck", purpose: OURS, expiry: PAST, state: "destroyFailed" })];
  const plan = planSweep(clusters, { now: NOW });
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /destroyFailed/);
});

test("planSweep --include-unlabelled takes expired clusters with no purpose", () => {
  const clusters = [
    cluster({ id: "unlabelled-expired", expiry: PAST }),
    cluster({ id: "unlabelled-live", expiry: FUTURE }),
    cluster({ id: "theirs-expired", purpose: "uiauto-aws", expiry: PAST }),
  ];
  const plan = planSweep(clusters, { includeUnlabelled: true, now: NOW });
  assert.deepEqual(
    plan.remove.map((c) => c.id),
    ["unlabelled-expired"],
  );
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
