/**
 * Unit tests for perf run identity: which versions are moving, and which runs are the same datapoint.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/ingest/tests/perf-identity.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_IDENTITY_KEYS, isMovingVersion, MOVING_RUN_RETENTION, movingRunsToDelete, PERF_IDENTITY_SQL, perfIdentity } from "../perf-identity.js";

function params(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    impl: { language: "Java", version: "main", image: { revision: "aaaaaaa", created: "2026-11-01T00:00:00Z" } },
    workload: { operations: [{ op: "get", bounds: { forSeconds: "$forSeconds" } }] },
    vars: { forSeconds: 300, poolSize: 10000, horizontalScaling: 1, driverVer: 6, performerVer: 1 },
    cluster: { version: "8.0.0", nodeCount: 1, memory: 4096, replicas: 0, type: "unmanaged", storage: "couchstore", connectionString: "couchbase://10.0.0.1" },
    debug: { items: [{ label: "CI run", url: "https://example.invalid/1" }] },
    ...overrides,
  };
}

test("main, master and X.Y.x branch snapshots are moving versions", () => {
  for (const version of ["main", "master", "3.11.x", "1.2.x"]) {
    assert.equal(isMovingVersion(version), true, version);
  }
});

test("releases, gerrit refs and on-demand builds are not moving versions", () => {
  for (const version of ["3.7.2", "3.7.2-SNAPSHOT", "refs/changes/01/248901/3", "refs-changes-01-248901-3", "sha-abc1234", "branch-3.12", "mainline"]) {
    assert.equal(isMovingVersion(version), false, version);
  }
});

test("a new commit on the same branch is the same datapoint", () => {
  const older = perfIdentity(params());
  const newer = perfIdentity(params({ impl: { language: "Java", version: "main", image: { revision: "bbbbbbb" } } }));
  assert.deepEqual(newer, older);
});

test("debug links and the per-run connection string don't change the identity", () => {
  const withThem = perfIdentity(params());
  const p = params();
  delete p.debug;
  (p.cluster as Record<string, unknown>).connectionString = "couchbase://10.9.9.9";
  assert.deepEqual(perfIdentity(p), withThem);
});

test("a null and an absent value are the same fact, as jsonb_strip_nulls sees it", () => {
  const p = params();
  (p.cluster as Record<string, unknown>).topology = null;
  (p.vars as Record<string, unknown>).tunable = null;
  assert.deepEqual(perfIdentity(p), perfIdentity(params()));
});

test("a different variable, workload, cluster version or node count is a different datapoint", () => {
  const base = perfIdentity(params())?.key;
  const variants = [
    params({ vars: { forSeconds: 300, poolSize: 20000, horizontalScaling: 1, driverVer: 6, performerVer: 1 } }),
    params({ vars: { forSeconds: 300, poolSize: 10000, horizontalScaling: 1, driverVer: 6, performerVer: 1, extra: true } }),
    params({ workload: { operations: [{ op: "replace", bounds: { forSeconds: "$forSeconds" } }] } }),
    params({ cluster: { version: "8.0.1", nodeCount: 1, memory: 4096, replicas: 0 } }),
    params({ cluster: { version: "8.0.0", nodeCount: 3, memory: 4096, replicas: 0 } }),
    params({ impl: { language: "Java", version: "3.11.x" } }),
    params({ impl: { language: "Scala", version: "main" } }),
  ];
  for (const variant of variants) {
    assert.notDeepEqual(perfIdentity(variant)?.key, base);
  }
});

test("a run with no language or version has no identity, and so is never matched", () => {
  assert.equal(perfIdentity(params({ impl: { language: "Java" } })), undefined);
  assert.equal(perfIdentity({}), undefined);
});

test("the SQL projection covers every cluster identity key", () => {
  for (const key of CLUSTER_IDENTITY_KEYS) {
    assert.match(PERF_IDENTITY_SQL, new RegExp(`'${key}', params->'cluster'->'${key}'`));
  }
});

const day = (d: number): Date => new Date(Date.UTC(2026, 10, d));
const stored = (id: string, d: number, revision?: string) => ({ id, datetime: day(d), ...(revision ? { revision } : {}) });

const oneCommit = { commits: 1, runsPerCommit: 5 };

test("by default the last 10 commits are kept, 5 runs each", () => {
  assert.deepEqual(MOVING_RUN_RETENTION, { commits: 10, runsPerCommit: 5 });
});

test("commits beyond the limit are deleted, oldest-built first", () => {
  const runs = [stored("a1", 1, "A"), stored("a2", 2, "A"), stored("b1", 3, "B"), stored("c1", 4, "C")];
  assert.deepEqual(movingRunsToDelete(runs, { commits: 2, runsPerCommit: 5 }).sort(), ["a1", "a2"]);
  assert.deepEqual(movingRunsToDelete(runs, oneCommit).sort(), ["a1", "a2", "b1"]);
  assert.deepEqual(movingRunsToDelete(runs), []);
});

test("runs of one commit are kept up to the cap, then the oldest goes", () => {
  const five = [1, 2, 3, 4, 5].map((d) => stored(`a${d}`, d, "A"));
  assert.deepEqual(movingRunsToDelete(five), []);
  assert.deepEqual(movingRunsToDelete([...five, stored("a6", 6, "A")]), ["a1"]);
  assert.deepEqual(movingRunsToDelete(five, { commits: 10, runsPerCommit: 3 }).sort(), ["a1", "a2"]);
});

test("the cap applies to each kept commit separately", () => {
  const runs = [...[1, 2, 3].map((d) => stored(`a${d}`, d, "A")), ...[4, 5, 6].map((d) => stored(`b${d}`, d, "B"))];
  assert.deepEqual(movingRunsToDelete(runs, { commits: 2, runsPerCommit: 2 }).sort(), ["a1", "b4"]);
});

test("a late upload of a commit that is out of the window deletes itself", () => {
  const runs = [stored("b1", 3, "B"), stored("late-a", 4, "A")].map((run, i) => ({ ...run, created: day(i === 0 ? 3 : 1) }));
  assert.deepEqual(movingRunsToDelete(runs, oneCommit), ["late-a"]);
});

test("a late upload of a kept commit is kept while within the cap", () => {
  const runs = [stored("a2", 2, "A"), stored("a3", 3, "A"), stored("late-a", 1, "A")];
  assert.deepEqual(movingRunsToDelete(runs), []);
});

test("runs with no revision count as one commit, of which only the newest run stays", () => {
  const runs = [stored("x1", 1), stored("x2", 2), stored("a1", 3, "A")];
  assert.deepEqual(movingRunsToDelete(runs), ["x1"]);
  assert.deepEqual(movingRunsToDelete(runs, oneCommit).sort(), ["x1", "x2"]);
});

test("a newest-built run with no revision still keeps only itself in a one-commit window", () => {
  const runs = [stored("a1", 1, "A"), stored("x1", 2), stored("x2", 3)];
  assert.deepEqual(movingRunsToDelete(runs, oneCommit).sort(), ["a1", "x1"]);
});

test("commits are ordered by image build time, not by when a run was ingested", () => {
  // Y ran on commit B (built day 5) and finished first; X, a long run on the older commit A
  // (built day 2), uploaded after it. With room for one commit, X goes, not Y.
  const y = { ...stored("y", 6, "B"), created: day(5) };
  const x = { ...stored("x", 7, "A"), created: day(2) };
  assert.deepEqual(movingRunsToDelete([y, x], oneCommit), ["x"]);
});

test("a run with no build time is ordered by its ingest time", () => {
  const built = { ...stored("built", 3, "A"), created: day(2) };
  const unbuilt = stored("unbuilt", 4, "B");
  assert.deepEqual(movingRunsToDelete([built, unbuilt], oneCommit), ["built"]);
});

test("no runs, nothing to delete", () => {
  assert.deepEqual(movingRunsToDelete([]), []);
});

test("fit-cli's runs are a different datapoint from the jenkins-sdk runs they otherwise match", () => {
  // jenkins-sdk wrote no runner, so without the name a fit-cli run of `main` would be retained
  // together with jenkins-sdk's, and enough new commits would delete that history.
  const jenkins = perfIdentity(params())?.key;
  const fitCli = perfIdentity(params({ runner: { name: "fit-cli", commit: "1111111" } }))?.key;
  assert.notDeepEqual(fitCli, jenkins);
});

test("a fit-cli commit, clean or dirty, doesn't change the identity: retention spans fit-cli's commits", () => {
  const a = perfIdentity(params({ runner: { name: "fit-cli", commit: "1111111" } }));
  const b = perfIdentity(params({ runner: { name: "fit-cli", commit: "2222222", dirty: true } }));
  const noCommit = perfIdentity(params({ runner: { name: "fit-cli" } }));
  assert.deepEqual(a, b);
  assert.deepEqual(a, noCommit);
});

test("the SQL projection keys on the runner's name and nothing else of it", () => {
  assert.match(PERF_IDENTITY_SQL, /'runner', params->'runner'->'name'/);
  assert.doesNotMatch(PERF_IDENTITY_SQL, /'commit'/);
});
