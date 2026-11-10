/**
 * Which perf runs are "the same datapoint", so that ingest can bound how many it keeps for a
 * moving version.
 *
 * A perf run always measures and always publishes. For a release (`3.7.2`) every run is a
 * fresh sample of the same immutable build, and the perf UI averages them. For a moving
 * version (`main`, `3.11.x`) each run measures whatever the branch held that night: the perf
 * UI shows one bar per recent commit, averaging that commit's runs, so ingest keeps the last
 * few commits with a few runs each and deletes the rest.
 *
 * The identity mirrors jenkins-sdk's run-matching key (`Run.toJson()` in its
 * `perf/shared/config/Config.groovy`), so a run ingested here lines up with the history it
 * wrote: language and version, every variable, the workload, and the cluster facts that
 * change what is measured. One addition: the producer's name (`runner.name`, which only fit-cli
 * writes), so that fit-cli's runs of a moving version are retained separately from the
 * jenkins-sdk runs they otherwise match, rather than pruning that history. Its commit is left
 * out, as the performer's is. Left out are the facts that differ between otherwise-identical
 * runs: the performer image block (its commit is exactly what a moving version changes), the
 * debug links, and the cluster's connection string (a per-run host).
 *
 * Run on its own, to see the identity a run.json5 would be matched on:
 *   bun src/fit/ingest/perf-identity.ts <run.json5>
 */
import { readFileSync } from "node:fs";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { parseRunJson5 } from "./parse.js";

/**
 * The cluster facts that are part of a datapoint's identity, as in jenkins-sdk's
 * `Cluster.toJsonRaw()`. Shared with the SQL that projects the same object out of
 * `runs.params`, so the two can't disagree.
 */
export const CLUSTER_IDENTITY_KEYS = [
  "version",
  "nodeCount",
  "memory",
  "cpuCount",
  "replicas",
  "instance",
  "compaction",
  "topology",
  "cloudNativeGatewayVersion",
] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Whether a performer version is a moving one: `main`, `master`, or a branch snapshot like
 * `3.11.x`. The perf UI uses the same rule (`isMovingVersion` in perf-sdk-frontend's
 * `src/lib/core-ui-utilities.ts`) to show only the newest run for these, so keep the two in
 * step — ingest replacing a run the UI would still average, or the reverse, would be confusing.
 */
export function isMovingVersion(version: string): boolean {
  return version === "main" || version === "master" || /^\d+\.\d+\.x$/.test(version);
}

/**
 * Drop null and absent values from objects, recursively. Postgres's `jsonb_strip_nulls` does
 * the same to the SQL side, and a key that is missing in one row and null in another is the
 * same fact.
 */
function stripNulls(value: unknown): Json | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => stripNulls(item) ?? null);
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value)) {
      const stripped = stripNulls(item);
      if (stripped !== undefined) out[key] = stripped;
    }
    return out;
  }
  return value as Json;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export interface PerfIdentity {
  language: string;
  version: string;
  /** The JSON object compared against {@link PERF_IDENTITY_SQL}'s projection of each stored run. */
  key: Json;
}

/** The identity of a perf run from its `runs.params`, or undefined when it has no language/version to match on. */
export function perfIdentity(params: Record<string, unknown>): PerfIdentity | undefined {
  const impl = recordOf(params.impl);
  const { language, version } = impl;
  if (typeof language !== "string" || typeof version !== "string") return undefined;

  const cluster = recordOf(params.cluster);
  const clusterKey: Record<string, unknown> = {};
  for (const key of CLUSTER_IDENTITY_KEYS) clusterKey[key] = cluster[key];

  const runner = recordOf(params.runner).name;
  const key = stripNulls({ runner, language, version, vars: params.vars, workload: params.workload, cluster: clusterKey }) ?? {};
  return { language, version, key };
}

/**
 * How many commits of a moving version are kept, newest-built first. The perf UI draws one bar
 * per commit (perf-sdk-frontend's `MOVING_COMMITS_SHOWN`, which should not exceed this), so this
 * is how much history a branch has.
 */
export const MOVING_COMMITS_KEPT = 10;

/**
 * How many runs of each commit are kept. One run is noisy; while the branch sits on the same
 * commit, nightly runs add samples that the perf UI averages, up to this many.
 */
export const MOVING_RUNS_KEPT_PER_COMMIT = 5;

export interface MovingRunRetention {
  commits: number;
  runsPerCommit: number;
}

export const MOVING_RUN_RETENTION: MovingRunRetention = { commits: MOVING_COMMITS_KEPT, runsPerCommit: MOVING_RUNS_KEPT_PER_COMMIT };

export interface StoredPerfRun {
  id: string;
  /** When the run was ingested (`runs.datetime`). */
  datetime: Date;
  /** The performer image's commit (`impl.image.revision`), when the image carried one. */
  revision?: string;
  /** When the performer image was built (`impl.image.created`), when the image carried one. */
  created?: Date;
}

/** Newest first by `datetime`, then id, so the order is total. */
function byDatetimeDesc(a: StoredPerfRun, b: StoredPerfRun): number {
  return b.datetime.getTime() - a.datetime.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * Of the runs of one moving-version datapoint, the ones to delete.
 *
 * Commits are ordered by when their image was built (`created`, as the container conventions
 * intend for ordering snapshots; `datetime` when an image has no build time) — not by when a
 * run was ingested, since a long run of an older commit can finish after a short run of a
 * newer one. The newest `retention.commits` commits stay, each with its newest
 * `retention.runsPerCommit` runs by `datetime`; everything else goes.
 *
 * Runs with no revision can't be told apart, so together they count as one commit, of which
 * only the newest run is kept (the perf UI would merge them into one bar anyway).
 */
export function movingRunsToDelete(runs: readonly StoredPerfRun[], retention: MovingRunRetention = MOVING_RUN_RETENTION): string[] {
  const builtAt = (run: StoredPerfRun): number => (run.created ?? run.datetime).getTime();
  const byCommit = new Map<string | undefined, StoredPerfRun[]>();
  for (const run of [...runs].sort(byDatetimeDesc)) {
    byCommit.set(run.revision, [...(byCommit.get(run.revision) ?? []), run]);
  }
  const commitBuiltAt = (commitRuns: readonly StoredPerfRun[]): number => Math.max(...commitRuns.map(builtAt));
  const commitsNewestFirst = [...byCommit.entries()].sort(
    ([, a], [, b]) => commitBuiltAt(b) - commitBuiltAt(a) || byDatetimeDesc(a[0], b[0]),
  );

  const keep = new Set<string>();
  for (const [revision, commitRuns] of commitsNewestFirst.slice(0, retention.commits)) {
    const perCommit = revision === undefined ? 1 : retention.runsPerCommit;
    for (const run of commitRuns.slice(0, perCommit)) keep.add(run.id);
  }
  return [...runs].sort(byDatetimeDesc).filter((run) => !keep.has(run.id)).map((run) => run.id);
}

/**
 * SQL projecting a stored run's `params` to the same object {@link perfIdentity} builds.
 * Built only from constants, so it is safe to splice into a query.
 */
export const PERF_IDENTITY_SQL = `jsonb_strip_nulls(jsonb_build_object(
  'runner', params->'runner'->'name',
  'language', params->'impl'->'language',
  'version', params->'impl'->'version',
  'vars', params->'vars',
  'workload', params->'workload',
  'cluster', jsonb_build_object(${CLUSTER_IDENTITY_KEYS.map((key) => `'${key}', params->'cluster'->'${key}'`).join(", ")})
))`;

if (isMain(import.meta.url)) {
  runCli(() => {
    const [file] = process.argv.slice(2);
    if (!file || file === "--help" || file === "-h") {
      console.log("Usage: bun src/fit/ingest/perf-identity.ts <run.json5>\n\nPrint the identity ingest matches a perf run on, and whether its version is a moving one.");
      return Promise.resolve({ artifacts: [], details: [] });
    }
    const run = parseRunJson5(readFileSync(file, "utf8"));
    const identity = perfIdentity(run.params);
    console.log(JSON.stringify(identity?.key ?? null, null, 2));
    const moving = identity !== undefined && isMovingVersion(identity.version);
    console.log(`\n${identity ? identity.version : "(no version)"}: ${moving ? `moving — ingest keeps the last ${MOVING_COMMITS_KEPT} commits, up to ${MOVING_RUNS_KEPT_PER_COMMIT} runs each` : "not moving — runs accumulate"}`);
    return Promise.resolve({ artifacts: [], details: [] });
  });
}
