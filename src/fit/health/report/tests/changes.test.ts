/**
 * Unit tests for working out what changed around a finding's change point: the SDK's commits
 * (path-aware for a repo holding several SDKs) and the FIT driver's.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/changes.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunManifest } from "../../record/run-manifest.js";
import type { HealthOptIn } from "../../registry/health-opt-ins.js";
import { DRIVER_REPO, analyseChanges, categorise, commitAt, splitDriverCommits, splitSdkCommits, testFilesFor, type ChangeSource } from "../changes.js";
import type { TriageFinding, TriageNight, TriageReport } from "../triage.js";

const c = (sha: string, title = sha) => ({ sha, title });

/** A ChangeSource from plain functions; one that throws becomes a rejected promise. */
type Sync = { [K in keyof ChangeSource]?: (...args: Parameters<ChangeSource[K]>) => Awaited<ReturnType<ChangeSource[K]>> };
const src = (s: Sync): ChangeSource => ({
  compare: (...a) => Promise.resolve().then(() => s.compare?.(...a) ?? []),
  files: (...a) => Promise.resolve().then(() => s.files?.(...a) ?? []),
  history: (...a) => Promise.resolve().then(() => s.history?.(...a) ?? []),
  tree: (...a) => Promise.resolve().then(() => s.tree?.(...a) ?? []),
});


test("a clone gets the newest commit that had landed by then", () => {
  const history = [
    { sha: "c3", landedAt: "2026-09-23T13:33:02.000Z" },
    { sha: "c2", landedAt: "2026-09-23T11:00:55.000Z" },
    { sha: "c1", landedAt: "2026-09-22T23:43:27.000Z" },
  ];
  assert.equal(commitAt(history, "2026-09-23T00:20:45.000Z"), "c1");
  assert.equal(commitAt(history, "2026-09-24T00:20:45.000Z"), "c3");
  assert.equal(commitAt(history, "2026-09-01T00:00:00.000Z"), undefined);
});

test("in a repo holding several SDKs, a commit counts for this SDK only through its own paths or its shared core", () => {
  const kotlin: Pick<HealthOptIn, "paths" | "sharedCorePaths" | "sharedHarnessPaths"> = {
    paths: ["kotlin-client/", "kotlin-fit-performer/"],
    sharedCorePaths: ["core-io/", "pom.xml"],
    sharedHarnessPaths: ["core-fit-performer/"],
  };
  const range = [
    { commit: c("java"), files: ["java-client/src/A.java"] },
    { commit: c("kotlin"), files: ["kotlin-client/src/K.kt"] },
    { commit: c("core"), files: ["core-io/src/C.java"] },
    { commit: c("rootpom"), files: ["pom.xml"] },
    { commit: c("harness"), files: ["core-fit-performer/src/P.java"] },
  ];
  assert.deepEqual(splitSdkCommits(range, kotlin), {
    commits: [c("kotlin")],
    sharedCoreCommits: [c("core"), c("rootpom")],
    sharedHarnessCommits: [c("harness")],
  });
  // A repo with one SDK: every commit is the SDK's.
  assert.deepEqual(splitSdkCommits(range, {}).commits.length, 5);
});

test("a driver commit decides only if it touches the test's own file; other test code is listed apart", () => {
  const tree = [
    "test-driver/src/test/java/com/couchbase/client/kv/rangescan/RangeScanTest.java",
    "test-driver/src/test/java/com/couchbase/client/kv/rangescan/util/RangeScanUtil.java",
    "test-driver/src/test/java/com/couchbase/client/OtherTest.java",
    "README.md",
  ];
  const files = testFilesFor("RangeScanTest", tree);
  assert.deepEqual(files, [tree[0]]);
  const split = splitDriverCommits(
    [
      { commit: c("9f9ed00b", "SDKQE-3058: Fix observability tests for RangeScan"), files: [tree[0], tree[1]] },
      { commit: c("util"), files: [tree[1]] },
      { commit: c("other"), files: [tree[2]] },
      { commit: c("docs"), files: ["README.md"] },
    ],
    files,
  );
  assert.deepEqual(split, { testFileCommits: [c("9f9ed00b", "SDKQE-3058: Fix observability tests for RangeScan")], helperCommits: [c("util")] });
});

test("Columnar's tests are found in columnar-test-driver, not test-driver", async () => {
  const { driverModuleFor } = await import("../changes.js");
  assert.equal(driverModuleFor("columnar-java"), "columnar-test-driver");
  assert.equal(driverModuleFor("analytics-dotnet"), "columnar-test-driver");
  assert.equal(driverModuleFor("dotnet"), "test-driver");
  const tree = ["columnar-test-driver/src/test/java/com/couchbase/fit/columnar/tests/query/QueryRetryTest.java", "test-driver/src/test/java/x/QueryRetryTest.java"];
  assert.deepEqual(testFilesFor("QueryRetryTest", tree, "columnar-test-driver"), [tree[0]]);
  const split = splitDriverCommits([{ commit: c("h"), files: ["columnar-test-driver/src/test/java/util/Helper.java"] }], [], "columnar-test-driver");
  assert.deepEqual(split.helperCommits, [c("h")]);
});

test("the category follows the SDK / test-file grid, and says when it can't tell", () => {
  const sdk = (changed: boolean) => ({ from: "a", to: "b", changed, commits: [], sharedCoreCommits: [], sharedHarnessCommits: [] });
  const driver = (testFileCommits: { sha: string; title: string }[] | null, helperCommits: { sha: string; title: string }[] = []) => ({
    from: { date: "d1", inferred: true },
    to: { date: "d2", inferred: true },
    changed: null,
    testFiles: [],
    testFileCommits,
    helperCommits,
  });
  assert.equal(categorise(sdk(false), driver([c("t")])).category, "test-changed");
  assert.equal(categorise(sdk(true), driver([])).category, "sdk");
  assert.equal(categorise(sdk(true), driver([c("t")])).category, "both");
  assert.equal(categorise(sdk(false), driver([], [c("h")])).category, "neither");
  assert.match(categorise(sdk(false), driver([], [c("h")])).reason ?? "", /shared test code/);
  assert.equal(categorise(undefined, driver([])).category, "unknown");
  assert.equal(categorise(sdk(false), driver(null)).category, "unknown");
});

const night = (date: string, runId: number, sha: string): TriageNight => ({
  date,
  outcome: "failed",
  run: { url: "", repo: "couchbase/couchbase-net-client", runId, attempt: 1, job: "fit / op-onprem-func-lite" },
  sdkCommit: sha,
  source: "run-archive-junit",
});
const manifest = (runId: number, clonedAt: string, gerritRef?: string): RunManifest => ({
  schema: 1,
  sdk: "dotnet",
  runId,
  runAttempt: 1,
  date: clonedAt.slice(0, 10),
  status: "ok",
  records: [],
  driver: { "fit / op-onprem-func-lite": { clonedAt, ...(gerritRef ? { gerritRef } : {}) } },
});
const report = (findings: TriageFinding[]): TriageReport => ({
  schema: "fit-health-triage/1",
  sdk: "dotnet",
  generatedAt: "",
  window: { start: "2026-09-01", end: "2026-09-30", nights: 30, classificationDays: 30, recentDays: 14 },
  coverage: { records: 0, fromJunit: 0, fromLog: 0 },
  blackout: [],
  unreadableRuns: [],
  series: [],
  findings,
  testsSeen: { functional: { tests: [], complete: true }, situational: { tests: [], complete: true } },
});
const finding = (test: string, before: TriageNight, after: TriageNight): TriageFinding => ({
  test,
  class: test.slice(0, test.indexOf(".")),
  method: test.slice(test.indexOf(".") + 1),
  series: "op-onprem-func-lite|functional",
  classification: { class: "failing", label: "Failing since", streak: 7, episodes: 1, windowFails: 7, windowRuns: 29 },
  history: [],
  evidence: { lastGood: { ...before, outcome: "passed" }, firstFailing: after },
  driverChanges: null,
  crossSdk: null,
});

test("the RangeScan night: same SDK commit, and the driver changed the test's own file - the test changed", async () => {
  const testFile = "test-driver/src/test/java/com/couchbase/client/kv/rangescan/RangeScanTest.java";
  const source = src({
    compare: (repo) => (repo === DRIVER_REPO ? [c("e273ae55", "SDKQE-3824"), c("9f9ed00b", "SDKQE-3058: Fix observability tests for RangeScan")] : []),
    files: (_repo, sha) => (sha === "9f9ed00b" ? [testFile] : [testFile.replace("RangeScanTest", "util/RangeScanUtil")]),
    history: () => [
      { sha: "9f9ed00b", landedAt: "2026-09-23T13:31:58.000Z" },
      { sha: "035d19b1", landedAt: "2026-09-22T23:43:27.000Z" },
    ],
    tree: () => [testFile],
  });
  const t = report([finding("RangeScanTest.testParentSpanPrefix", night("2026-09-23", 1, "afdb7689e"), night("2026-09-24", 2, "afdb7689e"))]);
  const r = await analyseChanges(t, {
    manifests: [manifest(1, "2026-09-23T00:20:45.000Z"), manifest(2, "2026-09-24T00:20:45.000Z")],
    optIn: { repo: "couchbase/couchbase-net-client", workflows: ["fit-testing-dotnet.yml"] },
    source,
  });
  assert.deepEqual(r, { analysed: 1, failed: 0 });
  const f = t.findings[0];
  assert.equal(f.evidence.sdkChange?.changed, false);
  assert.deepEqual([f.driverChanges?.from.sha, f.driverChanges?.to.sha], ["035d19b1", "9f9ed00b"]);
  assert.deepEqual(f.driverChanges?.testFileCommits?.map((x) => x.sha), ["9f9ed00b"]);
  assert.deepEqual(f.driverChanges?.helperCommits?.map((x) => x.sha), ["e273ae55"]);
  assert.deepEqual(f.changeAnalysis, { category: "test-changed", span: { from: "2026-09-23", to: "2026-09-24", days: 1 } });
});

test("a pinned Gerrit patchset is the driver exactly: the same pin is no change, a different one can't be compared", async () => {
  const source = src({ compare: () => [], files: () => [], history: () => [], tree: () => [] });
  const optIn = { repo: "couchbase/couchbase-net-client", workflows: ["x.yml"] };
  const same = report([finding("S.x", night("2026-09-23", 1, "a"), night("2026-09-24", 2, "a"))]);
  await analyseChanges(same, { manifests: [manifest(1, "2026-09-23T00:20:00.000Z", "refs/changes/15/252815/3"), manifest(2, "2026-09-24T00:20:00.000Z", "refs/changes/15/252815/3")], optIn, source });
  assert.deepEqual([same.findings[0].driverChanges?.changed, same.findings[0].changeAnalysis?.category], [false, "neither"]);
  const moved = report([finding("S.x", night("2026-09-23", 1, "a"), night("2026-09-24", 2, "a"))]);
  await analyseChanges(moved, { manifests: [manifest(1, "2026-09-23T00:20:00.000Z", "refs/changes/75/247275/2"), manifest(2, "2026-09-24T00:20:00.000Z", "refs/changes/15/252815/3")], optIn, source });
  assert.deepEqual([moved.findings[0].driverChanges?.changed, moved.findings[0].changeAnalysis?.category], [true, "unknown"]);
});

test("nights far apart say the comparison covers more than one night's changes", async () => {
  const source = src({ compare: () => [], files: () => [], history: () => [{ sha: "d0", landedAt: "2026-08-01T00:00:00.000Z" }], tree: () => [] });
  const t = report([finding("A.x", night("2026-08-20", 1, "a"), night("2026-08-28", 2, "a"))]);
  await analyseChanges(t, { manifests: [manifest(1, "2026-08-20T00:20:00.000Z"), manifest(2, "2026-08-28T00:20:00.000Z")], optIn: { repo: "o/r", workflows: ["x.yml"] }, source });
  assert.equal(t.findings[0].changeAnalysis?.span?.days, 8);
  assert.match(t.findings[0].changeAnalysis?.reason ?? "", /8 days apart/);
});

test("a driver cloned from a branch is unknown, not unchanged: a branch moves", async () => {
  const t = report([finding("A.x", night("2026-09-23", 1, "a"), night("2026-09-24", 2, "a"))]);
  const branchManifest = (runId: number, at: string): RunManifest => ({ ...manifest(runId, at), driver: { "fit / op-onprem-func-lite": { clonedAt: at, branch: "dk/x" } } });
  await analyseChanges(t, { manifests: [branchManifest(1, "2026-09-23T00:20:00.000Z"), branchManifest(2, "2026-09-24T00:20:00.000Z")], optIn: { repo: "o/r", workflows: ["x.yml"] }, source: src({}) });
  assert.equal(t.findings[0].driverChanges?.changed, null);
  assert.equal(t.findings[0].changeAnalysis?.category, "unknown");
});

test("a GitHub failure leaves the finding's category unknown, with the reason, and never throws", async () => {
  const source = src({
    compare: () => { throw new Error("HTTP 502"); },
    files: () => [],
    history: () => { throw new Error("HTTP 502"); },
    tree: () => [],
  });
  const t = report([finding("A.x", night("2026-09-23", 1, "a"), night("2026-09-24", 2, "b"))]);
  const r = await analyseChanges(t, { manifests: [manifest(1, "2026-09-23T00:20:00.000Z"), manifest(2, "2026-09-24T00:20:00.000Z")], optIn: { repo: "o/r", workflows: ["x.yml"] }, source });
  assert.deepEqual(r, { analysed: 1, failed: 1 });
  assert.equal(t.findings[0].changeAnalysis?.category, "unknown");
  assert.match(t.findings[0].changeAnalysis?.reason ?? "", /HTTP 502/);
});

test("no file found for the test's class: whether the test changed is unknown, not 'it didn't'", async () => {
  const source = src({
    compare: (repo) => (repo === DRIVER_REPO ? [c("h1", "helper change")] : []),
    files: () => ["test-driver/src/test/java/com/couchbase/client/util/Helper.java"],
    history: () => [{ sha: "d1", landedAt: "2026-09-23T13:00:00.000Z" }, { sha: "d0", landedAt: "2026-09-22T13:00:00.000Z" }],
    tree: () => [],
  });
  const t = report([finding("Missing.x", night("2026-09-23", 1, "a"), night("2026-09-24", 2, "a"))]);
  await analyseChanges(t, { manifests: [manifest(1, "2026-09-23T00:20:00.000Z"), manifest(2, "2026-09-24T00:20:00.000Z")], optIn: { repo: "o/r", workflows: ["x.yml"] }, source });
  const f = t.findings[0];
  assert.equal(f.driverChanges?.testFileCommits, null);
  assert.deepEqual(f.driverChanges?.helperCommits?.map((x) => x.sha), ["h1"]);
  assert.equal(f.changeAnalysis?.category, "unknown");
  assert.match(f.changeAnalysis?.reason ?? "", /no file for Missing found/);
});
