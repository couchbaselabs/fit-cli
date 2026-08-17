/**
 * Unit tests for the run.json5 debug links step.
 *
 * Run on their own:
 *   bun test src/fit/shared/results/tests/results-debug-links.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addDebugLinksToResults,
  CAPELLA_CLUSTER_ID_LABEL,
  ciRunUrl,
  debugFact,
  debugLinksFor,
  environmentDebugLinkContext,
  mergeDebugItems,
} from "../results-debug-links.js";
import type { EnvironmentsFile } from "../../../util/environments.js";

const environments = {
  capella: { dev: { endpoint: "https://api.dev.nonprod-project-avengers.com", oid: "org-1" } },
} as unknown as EnvironmentsFile;

const CLOUD_ID = "b0652a58-45d4-4cf7-afff-343ca735c6c6";

/** A SIT run.json5 as the test-driver writes it: facts as {label, description} items. */
function sitRecord(facts: Record<string, string>): unknown {
  return {
    forDatabase: {
      runUuid: "aaaaaaaa-0000-4000-8000-000000000001",
      workload: { situational: "SanityTest" },
      debug: { items: Object.entries(facts).map(([label, description]) => ({ label, description })) },
    },
  };
}

test("debugFact reads a driver fact by label", () => {
  assert.equal(debugFact(sitRecord({ [CAPELLA_CLUSTER_ID_LABEL]: CLOUD_ID }), CAPELLA_CLUSTER_ID_LABEL), CLOUD_ID);
  assert.equal(debugFact(sitRecord({ "cbdinocluster id": "x" }), CAPELLA_CLUSTER_ID_LABEL), undefined);
  assert.equal(debugFact({}, CAPELLA_CLUSTER_ID_LABEL), undefined);
});

test("debugLinksFor builds Capella links from the driver's own cluster id fact", () => {
  const links = debugLinksFor(sitRecord({ [CAPELLA_CLUSTER_ID_LABEL]: CLOUD_ID }), { capellaEnvironment: "dev" }, environments);
  assert.deepEqual(
    links.map((l) => l.label),
    ["Capella UI", "Fleet Manager", "DataDog logs"],
  );
  assert.ok(links[2]?.url?.includes(CLOUD_ID));
});

test("debugLinksFor prefers a cluster id fit-cli passes in (perf, where fit-cli allocated it)", () => {
  const perfRecord = { runUuid: "x", forDatabase: { workload: { operations: [] } } };
  const links = debugLinksFor(perfRecord, { capellaEnvironment: "dev", capellaClusterId: CLOUD_ID }, environments);
  assert.ok(links.find((l) => l.label === "Fleet Manager")?.url?.endsWith(`/clusters/${CLOUD_ID}`));
});

test("debugLinksFor builds no Capella links without a cluster id — e.g. a CNG run", () => {
  const links = debugLinksFor(sitRecord({ "cbdinocluster id": "abc" }), { capellaEnvironment: "dev" }, environments);
  assert.deepEqual(links, []);
});

test("debugLinksFor adds the CI URL and the run archive when known", () => {
  const links = debugLinksFor(
    {},
    { ciUrl: "https://github.com/o/r/actions/runs/1", archiveZipKey: "s3://fit-cli/runs/20261001-120000-ab12.zip" },
    environments,
  );
  assert.deepEqual(links.map((l) => l.label), ["CI URL", "Run archive"]);
  assert.equal(links[1]?.command, "fit archive fetch s3://fit-cli/runs/20261001-120000-ab12.zip");
  assert.ok(links[1]?.url?.includes("runs%2F20261001-120000-ab12.zip"));
});

test("mergeDebugItems appends to the driver's items and keeps everything else", () => {
  const record = sitRecord({ [CAPELLA_CLUSTER_ID_LABEL]: CLOUD_ID });
  const { record: merged, added } = mergeDebugItems(record, [{ label: "DataDog logs", url: "https://dd" }]);
  assert.equal(added.length, 1);
  const forDatabase = merged.forDatabase as { workload: unknown; debug: { items: { label: string }[] } };
  assert.deepEqual(forDatabase.workload, { situational: "SanityTest" });
  assert.deepEqual(forDatabase.debug.items.map((i) => i.label), [CAPELLA_CLUSTER_ID_LABEL, "DataDog logs"]);
});

test("mergeDebugItems is idempotent: a label already present isn't added again", () => {
  const once = mergeDebugItems(sitRecord({ "CI URL": "https://ci" }), [{ label: "CI URL", url: "https://ci" }, { label: "DataDog logs", url: "https://dd" }]);
  assert.deepEqual(once.added.map((l) => l.label), ["DataDog logs"]);
  const twice = mergeDebugItems(once.record, [{ label: "DataDog logs", url: "https://dd" }]);
  assert.deepEqual(twice.added, []);
});

test("ciRunUrl builds the GitHub Actions run URL, or nothing outside GHA", () => {
  assert.equal(
    ciRunUrl({ GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "couchbaselabs/fit-cli", GITHUB_RUN_ID: "42" }),
    "https://github.com/couchbaselabs/fit-cli/actions/runs/42",
  );
  assert.equal(ciRunUrl({}), undefined);
});

test("environmentDebugLinkContext only links the run archive when the zip will be uploaded", () => {
  assert.deepEqual(environmentDebugLinkContext({}, () => "/tmp/fit-cli/20261001-120000-ab12"), {});
  assert.equal(
    environmentDebugLinkContext({ GITHUB_ACTIONS: "true" }, () => "/tmp/fit-cli/20261001-120000-ab12").archiveZipKey,
    "s3://fit-cli/runs/20261001-120000-ab12.zip",
  );
});

test("addDebugLinksToResults rewrites each bundle's run.json5, honouring onlyDirs", () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "debug-links-test-"));
  for (const name of ["aaaaaaaa", "bbbbbbbb"]) {
    mkdirSync(join(resultsDir, name));
    writeFileSync(join(resultsDir, name, "run.json5"), JSON.stringify(sitRecord({ [CAPELLA_CLUSTER_ID_LABEL]: CLOUD_ID })));
  }
  const updated = addDebugLinksToResults(resultsDir, { capellaEnvironment: "dev" }, { onlyDirs: ["aaaaaaaa"], environments });
  assert.equal(updated, 1);
  const labelsOf = (name: string) =>
    (JSON.parse(readFileSync(join(resultsDir, name, "run.json5"), "utf8")) as { forDatabase: { debug: { items: { label: string }[] } } })
      .forDatabase.debug.items.map((i) => i.label);
  assert.deepEqual(labelsOf("aaaaaaaa"), [CAPELLA_CLUSTER_ID_LABEL, "Capella UI", "Fleet Manager", "DataDog logs"]);
  assert.deepEqual(labelsOf("bbbbbbbb"), [CAPELLA_CLUSTER_ID_LABEL]);
  // A second pass has nothing left to add.
  assert.equal(addDebugLinksToResults(resultsDir, { capellaEnvironment: "dev" }, { environments }), 1);
  assert.equal(addDebugLinksToResults(resultsDir, { capellaEnvironment: "dev" }, { environments }), 0);
});
